// contentScript.js (scanFlow + runWithMappings)

let running = false;
let stopRequested = false;

function uniqueSelector(el) {
    if (!el) return '';
    if (el.name) return `[name="${el.name}"]`;
    if (el.id) return `#${el.id}`;
    const parts = []; let node = el;
    while (node && node.tagName && node.tagName.toLowerCase() !== 'html') {
        let name = node.tagName.toLowerCase();
        if (node.id) { name += `#${node.id}`; parts.unshift(name); break; }
        let i = 1; let sib = node;
        while ((sib = sib.previousElementSibling) != null) { if (sib.tagName === node.tagName) i++; }
        if (i > 1) name += `:nth-of-type(${i})`;
        parts.unshift(name); node = node.parentElement;
    }
    return parts.join(' > ');
}

function detectVisibleForm() {
    const forms = Array.from(document.forms);
    return forms.find(f => f.offsetParent !== null) || forms[0] || null;
}

function snapshotFields() {
    const form = detectVisibleForm();
    if (!form) return { title: document.title, url: location.href, fields: [] };
    const fields = Array.from(form.querySelectorAll('input,textarea,select')).filter(f => f.type !== 'hidden');
    return {
        title: document.title, url: location.href, fields: fields.map(f => ({
            selector: uniqueSelector(f), name: f.name || '', id: f.id || '', tag: f.tagName.toLowerCase(), label: (() => {
                const l = document.querySelector(`label[for='${f.id}']`);
                return l ? l.innerText.trim() : (f.placeholder || '');
            })()
        }))
    };
}

// safe scan: block fetch/XHR/form.submit and try to click next-like buttons to record steps (maxSteps)
async function scanFlow(maxSteps = 10) {
    const pages = [];
    const origFetch = window.fetch;
    const origXhrOpen = window.XMLHttpRequest.prototype.open;
    const origFormSubmit = HTMLFormElement.prototype.submit;
    window.fetch = async () => new Promise(() => { }); // block
    window.XMLHttpRequest.prototype.open = function () { /* blocked during scan */ };
    HTMLFormElement.prototype.submit = function () { /* blocked during scan */ };
    try {
        for (let s = 0; s < maxSteps; s++) {
            pages.push(snapshotFields());
            // find candidate next button heuristically
            const candidates = Array.from(document.querySelectorAll('button,input,a')).filter(el => {
                const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                return /next|continue|proceed|forward|›|»|step|page/.test(txt);
            });
            if (!candidates || candidates.length === 0) break;
            const btn = candidates[0];
            const prevSnapshot = pages[pages.length - 1].fields.map(f => f.selector).join('|');
            const prevUrl = location.href;
            btn.click();
            await new Promise(r => setTimeout(r, 900));
            const curSnapshot = snapshotFields().fields.map(f => f.selector).join('|');
            if (location.href === prevUrl && curSnapshot === prevSnapshot) break; // didn't advance
            // else advanced -> continue
        }
    } catch (e) { /* ignore */ }
    finally {
        window.fetch = origFetch;
        window.XMLHttpRequest.prototype.open = origXhrOpen;
        HTMLFormElement.prototype.submit = origFormSubmit;
    }
    return pages;
}

function findEl(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
}

async function fillFields(mappingFields, rowObj) {
    for (const f of mappingFields) {
        if (stopRequested) return false;
        const sel = f.selector;
        const mapTo = f.mapTo || '';
        const val = mapTo ? (rowObj[mapTo] ?? '') : '';
        const el = findEl(sel);
        if (!el) continue;
        if (el.tagName.toLowerCase() === 'select') {
            const opt = Array.from(el.options).find(o => o.value == val) || Array.from(el.options).find(o => o.text == val);
            if (opt) el.value = opt.value; else el.value = val;
        } else if (el.type === 'checkbox' || el.type === 'radio') {
            const truth = (String(val).toLowerCase().trim() === 'true' || String(val) === '1' || String(val).toLowerCase().trim() === 'yes');
            el.checked = truth;
        } else {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    return true;
}

function clickSubmit(form) {
    if (!form) return false;
    const btn = form.querySelector('[type=submit], button:not([type])') || form.querySelector('button');
    if (btn) { btn.click(); return true; }
    try { form.submit(); return true; } catch (e) { return false; }
}

function waitForNextFormOrNavigation(previousUrl, timeoutMs = 9000) {
    return new Promise((resolve) => {
        let resolved = false;
        const to = setTimeout(() => { if (!resolved) { resolved = true; observer.disconnect(); resolve({ navigated: location.href !== previousUrl, form: detectVisibleForm() }); } }, timeoutMs);
        const observer = new MutationObserver(() => {
            if (resolved) return;
            const f = detectVisibleForm();
            if (f) { resolved = true; clearTimeout(to); observer.disconnect(); resolve({ navigated: location.href !== previousUrl, form: f }); }
        });
        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        const interval = setInterval(() => { if (location.href !== previousUrl && !resolved) { resolved = true; clearTimeout(to); observer.disconnect(); clearInterval(interval); resolve({ navigated: true, form: detectVisibleForm() }); } }, 250);
    });
}

async function runPagesForRow(pages, rowObj, delay = 800) {
    for (let p = 0; p < pages.length; p++) {
        if (stopRequested) return false;
        const page = pages[p];
        await fillFields(page.fields, rowObj);
        const form = detectVisibleForm();
        const prevUrl = location.href;
        clickSubmit(form);
        await waitForNextFormOrNavigation(prevUrl, 9000);
        await new Promise(r => setTimeout(r, delay));
    }
    return true;
}

// runtime listener
chrome.runtime.onMessage.addListener(async (msg, sender, sendResp) => {
    if (msg.type === 'scanFlow') {
        chrome.runtime.sendMessage({ type: 'log', text: 'scanFlow started (safe). Blocking network.' });
        const pages = await scanFlow(msg.payload?.maxSteps || 10);
        chrome.runtime.sendMessage({ type: 'scanResult', pages });
        chrome.runtime.sendMessage({ type: 'log', text: `scanFlow complete: ${pages.length} step(s).` });
        return;
    }

    if (msg.type === 'startBulk') {
        if (running) { chrome.runtime.sendMessage({ type: 'log', text: 'Already running.' }); return; }
        running = true; stopRequested = false;
        const { pages, csv, screenshot } = msg.payload;
        const header = csv.header;
        const rows = csv.rows.map(r => { const obj = {}; header.forEach((h, i) => obj[h] = r[i] || ''); return obj; });
        chrome.runtime.sendMessage({ type: 'log', text: `Starting ${rows.length} rows` });
        for (let i = 0; i < rows.length; i++) {
            if (stopRequested) break;
            chrome.runtime.sendMessage({ type: 'log', text: `Row ${i + 1}/${rows.length}` });
            const ok = await runPagesForRow(pages, rows[i]);
            if (!ok) chrome.runtime.sendMessage({ type: 'log', text: 'Row failed/stopped.' });
            // screenshot placeholder
            if (screenshot) chrome.runtime.sendMessage({ type: 'log', text: 'Screenshot requested (implement capture in background for real files).' });
            await new Promise(r => setTimeout(r, 700));
        }
        running = false; chrome.runtime.sendMessage({ type: 'finished' });
        return;
    }

    if (msg.type === 'stopBulk') {
        stopRequested = true; running = false; chrome.runtime.sendMessage({ type: 'log', text: 'Stop requested.' });
        return;
    }
});
