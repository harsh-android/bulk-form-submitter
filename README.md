Usage:
1. Load extension (Developer mode -> Load unpacked) and select extension folder.
2. Open the first step of form.
3a. For manual: click Detect -> Add Page. Navigate to next step, repeat Detect -> Add Page.
3b. For automatic: click Scan Flow (safe). Extension will try to record up to 10 steps without submitting real data.
4. Upload CSV (header row required).
5. Map CSV columns to detected fields in the mapping UI (dropdowns).
6. Click Run Bulk Submit. Use Stop to interrupt.
7. Screenshot option runs only after a row submission; the minimal sample puts a placeholder. To enable real screenshots we can add capture + save logic in background service worker.
Notes:
- Complex single-page JS wizards may need manual mapping per step.
- Scan Flow is heuristic — test on a copy / dev environment first.
