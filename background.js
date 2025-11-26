// background.js — inject content script on demand (useful while developing)
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['contentScript.js']
    });
    console.log('[ext] contentScript injected to tab', tab.id);
  } catch (e) {
    console.error('[ext] inject failed', e);
  }
});
