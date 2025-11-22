chrome.runtime.onMessage.addListener((msg, sender, sendResp) => {
    if (msg.type === 'captureScreenshot') {
        chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) sendResp({ ok: false, error: chrome.runtime.lastError.message });
            else sendResp({ ok: true, dataUrl });
        });
        return true; // async
    }
});