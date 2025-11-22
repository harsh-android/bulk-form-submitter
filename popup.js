// Simple popup logic: detect fields, parse CSV, map columns and send instructions to content script

// CSV parsing utility - lightweight (no external libs required)
function parseCSV(text) {
    const rows = text.trim().split(/\r?\n/).map(r => r.split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map(c => c.replace(/^\s*"|"\s*$/g, '').trim()));
    const header = rows.shift() || [];
    return { header, rows };
}

const detectBtn = document.getElementById('detect');
const status = document.getElementById('status');
const fieldsArea = document.getElementById('fieldsArea');
const fieldsList = document.getElementById('fieldsList');
const csvFile = document.getElementById('csvFile');
const mappingArea = document.getElementById('mappingArea');
const mappingList = document.getElementById('mappingList');
const controls = document.getElementById('controls');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const delayInput = document.getElementById('delay');
const log = document.getElementById('log');

let detectedFields = [];
let csv = null;
let running = false;
let csvRows = [];

function appendLog(msg) { log.textContent += msg + '\n'; }

// Ask active tab's content script to enumerate form fields
async function detectFields() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return status.textContent = 'No active tab';
    appendLog('Requesting fields from page...');
    chrome.tabs.sendMessage(tab.id, { type: 'detectFields' }, (resp) => {
        if (chrome.runtime.lastError) {
            status.textContent = 'Error: ' + chrome.runtime.lastError.message + '. Make sure the page allows content scripts.';
            return;
        }
        detectedFields = resp.fields || [];
        renderDetected();
    });
}

function renderDetected() {
    fieldsList.innerHTML = '';
    if (!detectedFields.length) {
        fieldsList.textContent = 'No form fields detected on this page.';
        fieldsArea.style.display = 'block';
        mappingArea.style.display = 'none';
        controls.style.display = 'none';
        return;
    }
    detectedFields.forEach((f, i) => {
        const div = document.createElement('div');
        div.textContent = `${i + 1}. ${f.tag} name='${f.name}' id='${f.id}' type='${f.type}' selector='${f.selector}'`;
        fieldsList.appendChild(div);
    });
    fieldsArea.style.display = 'block';
    if (csv) buildMappingUI();
}

// CSV handling
csvFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseCSV(text);
    if (!parsed.header.length) { appendLog('CSV parse error: no header row'); return; }
    csv = parsed;
    csvRows = parsed.rows;
    appendLog('CSV loaded: ' + csv.header.join(', '));
    if (detectedFields.length) buildMappingUI();
});

function buildMappingUI() {
    mappingList.innerHTML = '';
    detectedFields.forEach((f, idx) => {
        const row = document.createElement('div');
        row.style.margin = '6px 0';
        row.innerHTML = `<label>${f.selector} ➜ </label>`;
        const sel = document.createElement('select');
        const emptyOpt = document.createElement('option'); emptyOpt.value = ''; emptyOpt.textContent = '-- (leave empty) --'; sel.appendChild(emptyOpt);
        csv.header.forEach(h => { const o = document.createElement('option'); o.value = h; o.textContent = h; sel.appendChild(o); });
        row.appendChild(sel);
        mappingList.appendChild(row);
    });
    mappingArea.style.display = 'block';
    controls.style.display = 'block';
}

// Produce mapping object {selector: columnName}
function readMapping() {
    const selects = mappingList.querySelectorAll('select');
    const mapping = {};
    selects.forEach((s, i) => {
        const col = s.value;
        if (col) mapping[detectedFields[i].selector] = col;
    });
    return mapping;
}

startBtn.addEventListener('click', async () => {
    if (!csv || !csvRows.length) { appendLog('Load CSV first'); return; }
    const mapping = readMapping();
    if (Object.keys(mapping).length === 0) { appendLog('Create at least one mapping'); return; }
    const delay = parseInt(delayInput.value || 1000, 10);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return appendLog('No active tab');
    running = true;
    appendLog('Starting bulk submit...');
    chrome.tabs.sendMessage(tab.id, { type: 'startBulk', mapping, rows: csvRows, delay }, (resp) => {
        if (chrome.runtime.lastError) appendLog('Error sending message: ' + chrome.runtime.lastError.message);
        else appendLog('Command sent to content script.');
    });
});

stopBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    running = false;
    chrome.tabs.sendMessage(tab.id, { type: 'stopBulk' }, () => { appendLog('Stop signalled'); });
});

// incoming messages from content script (optional status updates)
chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
    if (msg.type === 'log') appendLog(msg.msg);
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'screenshotResult') {
        if (msg.ok) {
            document.getElementById('screenshotPreview').style.display = 'block';
            document.getElementById('screenshotImg').src = msg.dataUrl;
            document.getElementById('downloadShot').href = msg.dataUrl;
        } else {
            console.log('Screenshot failed', msg.error);
        }
    }
});

detectBtn.addEventListener('click', detectFields);

// try to detect fields automatically when popup opens
(async () => { appendLog('Popup ready'); })();