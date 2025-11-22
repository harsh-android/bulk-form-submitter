# Bulk Form Submitter — Chrome Extension

## Install
1. Save the files in a folder.
2. Go to chrome://extensions, enable Developer mode.
3. Click "Load unpacked" and select the folder.

## How to use
1. Open the target page that contains the form and reload it.
2. Click the extension icon (popup will open).
3. Click "Detect form fields" — the extension will show detected fields (selector, name, id).
4. Upload a CSV with header row. (CSV should have column names matching the values you want to map.)
5. Map CSV columns to form fields in the popup.
6. Click Start. The extension will fill and submit for each CSV row with the specified delay.

## Important notes & limitations
- Many modern sites protect forms with CSRF tokens, captchas, or server-side validations; automated repeated submissions may fail or be blocked.
- Some forms require multi-step interactions or dynamic JS; basic field assignment may not trigger required client-side logic. You may need to add extra triggers in the content script.
- Respect site terms of service and legal/regulatory constraints.


Some new Features added