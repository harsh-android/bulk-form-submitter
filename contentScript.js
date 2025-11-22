// Content script: detects forms and fields, and performs filling + submitting when commanded by popup.

let isRunning = false;
let currentAbort = false;

function uniqueSelector(el){
  // simple selector generator: prefer name, id else fallback to tag+index
  if(!el) return '';
  if(el.name) return `[name="${el.name}"]`;
  if(el.id) return `#${el.id}`;
  // fallback compute path
  const path = [];
  let node = el;
  while(node && node.nodeType===1 && node.tagName.toLowerCase()!=='html'){
    let name = node.tagName.toLowerCase();
    if(node.id) { name += `#${node.id}`; path.unshift(name); break; }
    let i = 1; let sib = node; while((sib = sib.previousElementSibling) != null){ if(sib.tagName===node.tagName) i++; }
    if(i>1) name += `:nth-of-type(${i})`;
    path.unshift(name);
    node = node.parentElement;
  }
  return path.join(' > ');
}

function detectFormFields(){
  const forms = Array.from(document.forms);
  if(forms.length===0) return [];
  // pick the first visible form (best effort)
  const form = forms.find(f=>f.offsetParent!==null) || forms[0];
  const fields = Array.from(form.querySelectorAll('input,textarea,select')).filter(f=>f.type!=='hidden');
  return fields.map(f=>({
    tag: f.tagName.toLowerCase(),
    type: f.type||'',
    name: f.name||'',
    id: f.id||'',
    selector: uniqueSelector(f)
  }));
}

function findBySelector(sel){
  try{ return document.querySelector(sel); }catch(e){
    // if selector is attribute selector like [name="foo"] it should work; otherwise try fallback by matching name/id
    if(sel.startsWith('[name="')){
      const name = sel.replace(/\[name=\"|\"\]/g,'');
      return document.querySelector(`[name="${name}"]`);
    }
    return null;
  }
}

async function fillAndSubmitRow(mapping, row){
  // mapping: { selector: csvColumnName }
  for(const sel in mapping){
    const el = findBySelector(sel);
    if(!el) continue;
    const val = row[mapping[sel]] || '';
    // set value appropriately
    if(el.tagName.toLowerCase()==='select'){
      // try to set by option value or text
      let opt = Array.from(el.options).find(o=>o.value==val) || Array.from(el.options).find(o=>o.text==val);
      if(opt) el.value = opt.value;
      else el.value = val;
    }else if(el.type==='checkbox' || el.type==='radio'){
      // basic handling: if value is truthy, check it
      el.checked = !!val && (val.toLowerCase ? (val.toLowerCase()==='true' || val==='1' || val.toLowerCase()==='yes') : !!val);
    }else{
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    }
  }
  // trigger submit: prefer native form submit, else try click submit button
  const forms = Array.from(document.forms);
  const form = forms.find(f=>Array.from(f.elements).some(e=>Object.keys(mapping).includes(uniqueSelector(e)))) || document.forms[0];
  if(!form) return false;
  // try to find submit button
  const submitBtn = form.querySelector('[type=submit], button:not([type])') || form.querySelector('button');
  if(submitBtn){
    submitBtn.click();
  }else{
    form.submit();
  }
  return true;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg,sender,sendResp)=>{
  if(msg.type==='detectFields'){
    const fields = detectFormFields();
    sendResp({fields});
    return true; // indicates async
  }
  if(msg.type==='startBulk'){
    if(isRunning) { chrome.runtime.sendMessage({type:'log', msg:'Already running'}); return; }
    isRunning = true; currentAbort = false;
    runBulk(msg.mapping, msg.rows, msg.delay);
    sendResp({ok:true});
    return true;
  }
  if(msg.type==='stopBulk'){
    currentAbort = true;
    isRunning = false;
    sendResp({ok:true});
    return true;
  }
});

async function runBulk(mapping, rows, delay){
  chrome.runtime.sendMessage({type:'log', msg:`Bulk run started: ${rows.length} rows, delay ${delay}ms`});
  for(let i=0;i<rows.length;i++){
    if(currentAbort) { chrome.runtime.sendMessage({type:'log', msg:'Stopped by user'}); break; }
    const row = rows[i];
    const mappedRow = {};
    // row is an array if parsed; we need to map header->value. The popup sends rows as arrays; popup mapping maps selector->columnName
    // We'll assume popup sent rows as arrays with header known; to simplify, popup sends rows as arrays but mapping uses column names => we must transform.
    // But popup currently sends 'rows' as arrays and mapping as {selector: columnName}
    // To make it work, the popup already sent csvRows as arrays but omitted header; to reconcile, the popup actually should send rows as objects.
    // To keep content script robust, check if rows[i] is array or object.

    // If rows are arrays, we cannot map by column name. So popup should send rows as objects {colName: value}. To keep backward compatibility, detect and handle.
    let rowObj = row;
    if(Array.isArray(row)){
      // try to get header from message? if not available we can't map; we'll just skip.
      chrome.runtime.sendMessage({type:'log', msg:'Row is array — mapping by header not possible. Please update popup to send objects.'});
      isRunning=false; return;
    }

    // Build mapping for this row: mapping selector => value
    const selectorToVal = {};
    for(const sel in mapping){
      const col = mapping[sel];
      selectorToVal[sel] = rowObj[col] || '';
    }
    chrome.runtime.sendMessage({type:'log', msg:`Submitting row ${i+1}/${rows.length}`});
    const ok = await fillAndSubmitRow(selectorToVal, rowObj);
    if(!ok) chrome.runtime.sendMessage({type:'log', msg:'Failed to find form to submit for this row.'});
    // wait
    await new Promise(r=>setTimeout(r, delay||1000));
  }
  isRunning=false; chrome.runtime.sendMessage({type:'log', msg:'Bulk run finished.'});
}