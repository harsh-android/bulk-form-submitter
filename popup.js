// popup.js (Bootstrap UI + fixed mapping dropdowns + persistence)

// CSV parser (basic, supports quoted values)
function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let line of lines) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i+1] === '"') { cur += '"'; i++; continue; }
        inQuotes = !inQuotes; continue;
      }
      if (ch === ',' && !inQuotes) { cells.push(cur); cur=''; continue; }
      cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(c => c.trim()));
  }
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows.shift();
  return { header, rows };
}

// DOM refs
const detectBtn = document.getElementById('detect');
const addPageBtn = document.getElementById('addPage');
const clearPagesBtn = document.getElementById('clearPages');
const pagesArea = document.getElementById('pagesArea');
const csvFile = document.getElementById('csvFile');
const mappingArea = document.getElementById('mappingArea');
const runBtn = document.getElementById('run');
const stopBtn = document.getElementById('stop');
const logBox = document.getElementById('log');
const screenshotOpt = document.getElementById('screenshotOpt');
const csvInfo = document.getElementById('csvInfo');

let pages = [];            // persisted: [{title,url,fields:[{selector,name,label}]}]
let mappings = {};        // selector -> csvHeader
let csvData = null;
let lastDetected = null;
let running = false;

function appendLog(msg){
  const el = document.createElement('div');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
}
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

function saveState(){ chrome.storage.local.set({ pages, mappings }); }
function loadState(){
  chrome.storage.local.get(['pages','mappings'], (res) => {
    if (res.pages) pages = res.pages;
    if (res.mappings) mappings = res.mappings || {};
    renderPages();
  });
}

function renderPages(){
  if (!pages || pages.length === 0) {
    pagesArea.innerHTML = `<div class="alert alert-info py-2 mb-0">No pages recorded yet. Click <strong>Detect</strong> to analyze the current form (auto single/multi).</div>`;
    mappingArea.innerHTML = `<div class="text-muted">Upload CSV and record pages to enable mapping UI.</div>`;
    return;
  }
  let html = '';
  pages.forEach((p, i) => {
    html += `<div class="card mb-2"><div class="card-body p-2">
      <div class="d-flex align-items-start">
        <div class="me-2"><strong>Step ${i+1}</strong></div>
        <div class="text-truncate" style="max-width:520px;"><small class="text-muted">${escapeHtml(p.title||p.url||'detected')}</small></div>
      </div>
      <ul class="mb-0 mt-2">`;
    p.fields.forEach((f,fi) => {
      const mapped = mappings[f.selector] || '';
      html += `<li class="small py-1"><code>${escapeHtml(f.selector)}</code> — ${escapeHtml(f.label||f.name||'')} <span class="badge bg-light text-dark ms-2">${escapeHtml(mapped)}</span></li>`;
    });
    html += `</ul></div></div>`;
  });
  pagesArea.innerHTML = html;
  renderMappingUI();
}

// mapping UI: show dropdowns with CSV headers
function renderMappingUI(){
  if (!csvData || !csvData.header || csvData.header.length === 0 || !pages || pages.length === 0) {
    mappingArea.innerHTML = '<div class="text-muted">Upload CSV and have detected pages to enable mapping UI.</div>';
    return;
  }

  let html = `<div><h6>Field mappings</h6><small class="text-muted">Select CSV column for each detected field.</small>`;
  pages.forEach((p, pi) => {
    html += `<div class="mt-2 p-2 border rounded bg-white"><strong>Step ${pi+1}</strong>`;
    p.fields.forEach((f, fi) => {
      const selId = `map_${pi}_${fi}`;
      const cur = mappings[f.selector] || '';
      html += `<div class="row align-items-center g-1 my-1">
        <div class="col-7"><code>${escapeHtml(f.selector)}</code><div class="small text-muted">${escapeHtml(f.label||f.name||'')}</div></div>
        <div class="col-5">
          <select id="${selId}" class="form-select form-select-sm map-select" data-selector="${escapeHtml(f.selector)}">
            <option value="">-- unmapped --</option>`;
      csvData.header.forEach(h => {
        // Use raw header as option.value (no escaping) to ensure equality checks work
        const selected = (h === cur) ? ' selected' : '';
        html += `<option value="${h.replace(/"/g,'&quot;')}"${selected}>${escapeHtml(h)}</option>`;
      });
      html += `</select></div></div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  mappingArea.innerHTML = html;

  // Remove old delegated listener if any, then attach one
  mappingArea.removeEventListener('change', mappingChangeHandler);
  mappingArea.addEventListener('change', mappingChangeHandler);
}

// delegated handler
function mappingChangeHandler(e) {
  const sel = e.target;
  if (!sel || !sel.classList || !sel.classList.contains('map-select')) return;
  const selectorKey = sel.getAttribute('data-selector');
  // browser gives option.value as string; we trimmed headers earlier so values match
  const val = sel.value;
  if (val) mappings[selectorKey] = val;
  else delete mappings[selectorKey];
  saveState();
  // update visible pages list immediately
  renderPages();
  appendLog(`Mapped ${selectorKey} -> ${val || '<unmapped>'}`);
}


// initial load
loadState();
appendLog('Popup ready.');

// Detect: ask content script to snapshot + possibly run safe scanFlow
detectBtn.addEventListener('click', async () => {
  appendLog('Detecting current page and checking for multi-step...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // snapshot + quick heuristic for next-like controls
      function uniqueSelector(el){
        if (!el) return '';
        if (el.name) return `[name="${el.name}"]`;
        if (el.id) return `#${el.id}`;
        const parts=[]; let node=el;
        while (node && node.tagName && node.tagName.toLowerCase()!=='html'){
          let name=node.tagName.toLowerCase();
          if (node.id){ name += `#${node.id}`; parts.unshift(name); break }
          let i=1; let sib=node;
          while ((sib = sib.previousElementSibling) != null) { if (sib.tagName === node.tagName) i++; }
          if (i>1) name += `:nth-of-type(${i})`;
          parts.unshift(name); node = node.parentElement;
        }
        return parts.join(' > ');
      }
      function detectVisibleForm() {
        const forms = Array.from(document.forms);
        return forms.find(f => f.offsetParent !== null) || forms[0] || null;
      }
      function snapshot(){
        const form = detectVisibleForm();
        if (!form) return { title: document.title, url: location.href, fields: [] };
        const fields = Array.from(form.querySelectorAll('input,textarea,select')).filter(f => f.type !== 'hidden');
        return { title: document.title, url: location.href, fields: fields.map(f=>({ selector: uniqueSelector(f), name: f.name||'', id: f.id||'', tag: f.tagName.toLowerCase(), label: (document.querySelector(`label[for='${f.id}']`)?.innerText||f.placeholder||'') })) };
      }
      const nextCandidates = Array.from(document.querySelectorAll('button,input,a')).filter(el => {
        const txt = (el.innerText||el.value||el.getAttribute('aria-label')||'').toLowerCase();
        return /next|continue|proceed|forward|›|»|step|page/.test(txt);
      });
      const hasWizard = !!document.querySelector('[role="tablist"], .wizard, .step, .progress');
      return { snapshot: snapshot(), possiblyMulti: (nextCandidates.length>0) || hasWizard };
    }
  }, (res) => {
    if (!res || !res[0] || !res[0].result) { appendLog('Detect failed'); return; }
    const r = res[0].result;
    lastDetected = r.snapshot;
    if (!r.possiblyMulti) {
      // single page -> use snapshot as only step
      pages = [ lastDetected ];
      mappings = mappings || {};
      saveState();
      appendLog('Single-page form detected. Saved current page.');
      renderPages();
    } else {
      appendLog('Possible multi-step detected. Requesting safe scanFlow...');
      chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'scanFlow', payload: { maxSteps: 12 } }, () => {
          appendLog('scanFlow requested; waiting for results...');
        });
      });
    }
  });
});

// Manual add page (snapshot & save)
addPageBtn.addEventListener('click', async () => {
  appendLog('Manual detect -> adding current page snapshot...');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function uniqueSelector(el){
        if (!el) return '';
        if (el.name) return `[name="${el.name}"]`;
        if (el.id) return `#${el.id}`;
        const parts=[]; let node=el;
        while (node && node.tagName && node.tagName.toLowerCase()!=='html'){
          let name=node.tagName.toLowerCase();
          if (node.id){ name += `#${node.id}`; parts.unshift(name); break }
          let i=1; let sib=node;
          while ((sib = sib.previousElementSibling) != null) { if (sib.tagName === node.tagName) i++; }
          if (i>1) name += `:nth-of-type(${i})`;
          parts.unshift(name); node = node.parentElement;
        }
        return parts.join(' > ');
      }
      function detectVisibleForm(){ const forms = Array.from(document.forms); return forms.find(f=>f.offsetParent !== null) || forms[0] || null; }
      const form = detectVisibleForm();
      if (!form) return null;
      const fields = Array.from(form.querySelectorAll('input,textarea,select')).filter(f => f.type !== 'hidden');
      return { title: document.title, url: location.href, fields: fields.map(f=>({ selector: uniqueSelector(f), name: f.name||'', id: f.id||'', tag: f.tagName.toLowerCase(), label: (document.querySelector(`label[for='${f.id}']`)?.innerText||f.placeholder||'') })) };
    }
  }, (res) => {
    if (!res || !res[0] || !res[0].result) { appendLog('No form found on page.'); return; }
    pages.push(res[0].result);
    saveState();
    appendLog('Page manually added. Total pages: ' + pages.length);
    renderPages();
  });
});

// Clear pages
clearPagesBtn.addEventListener('click', () => {
  pages = []; mappings = {}; saveState(); renderPages(); appendLog('Cleared pages & mappings.');
  // in popup console
chrome.storage.local.remove(['mappings'], () => console.log('mappings removed'));

});

// CSV loaded
// CSV loaded
csvFile.addEventListener('change', (e) => {
  const f = csvFile.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    csvData = parseCSV(ev.target.result);
    // TRIM HEADERS to avoid invisible-spaces mismatch
    csvData.header = csvData.header.map(h => (typeof h === 'string' ? h.trim() : h));
    appendLog(`CSV loaded: ${csvData.rows.length} rows, ${csvData.header.length} columns.`);
    csvInfo.textContent = `CSV: ${f.name} — ${csvData.rows.length} rows, ${csvData.header.length} columns.`;
    renderMappingUI();
  };
  reader.readAsText(f);
});


// Run request (send mapping info to content script)
runBtn.addEventListener('click', async () => {
  if (!csvData || csvData.rows.length === 0) { appendLog('Please upload CSV first.'); return; }
  if (!pages || pages.length === 0) { appendLog('No pages recorded. Use Detect or Manual Add.'); return; }
  // construct pagesForRun: include mapTo property (selector->header)
  const pagesForRun = pages.map(p => ({
    title: p.title, url: p.url,
    fields: p.fields.map(f => ({ selector: f.selector, name: f.name, label: f.label, mapTo: mappings[f.selector] || '' }))
  }));
  const payload = { pages: pagesForRun, csv: csvData, screenshot: screenshotOpt.checked };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: 'startBulk', payload });
  appendLog('Run requested. Check site tab for progress; logs will appear here.');
});

// Stop
stopBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'stopBulk' });
    appendLog('Stop requested.');
  });
});

// listen for messages from contentScript (logs & scanResult)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log') appendLog(msg.text);
  else if (msg.type === 'finished') appendLog('Bulk run finished.');
  else if (msg.type === 'scanResult') {
    pages = msg.pages || [];
    mappings = {}; // clear mappings on new scan
    saveState();
    appendLog(`scanFlow returned ${pages.length} step(s).`);
    renderPages();
  }
});
