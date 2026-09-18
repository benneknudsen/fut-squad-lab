/**
 * MAIN-world bootstrap for the FUT Squad Lab bridge.
 *
 * Manifest-declared content scripts are classic scripts: they cannot use static
 * `import`, and the MAIN world has no `chrome.*` APIs to resolve an extension
 * URL. So this file does the minimum a MAIN-world script must do itself — listen
 * for the relay's message, validate the module URL and dynamically import
 * `src/page-bridge-app.js` — and all real logic lives in that ES module.
 *
 * The tag literals below mirror `src/ui/messages.js`; the two files cannot
 * import each other, so `test/bootstrap.test.js` locks them together.
 */
(() => {
  const PAGE_SOURCE = 'fsl-page';
  const CONTENT_SOURCE = 'fsl-content';
  const BRIDGE_MODULE_KIND = 'bridge-module';
  const BRIDGE_MODULE_SUFFIX = '/src/page-bridge-app.js';

  let started = false;

  const report = (message) =>
    window.postMessage({ source: PAGE_SOURCE, kind: 'error', message }, '*');

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== CONTENT_SOURCE) return;
    if (data.kind !== BRIDGE_MODULE_KIND || started) return;
    if (
      typeof data.url !== 'string' ||
      !data.url.startsWith('chrome-extension://') ||
      !data.url.endsWith(BRIDGE_MODULE_SUFFIX)
    ) {
      report(
        `refused bridge module URL ${String(data.url)}; expected this extension's` +
          ` ${BRIDGE_MODULE_SUFFIX}`
      );
      return;
    }
    started = true;
    import(data.url)
      .then((module) => module.startPageBridge(window))
      .catch((error) => {
        started = false;
        report(`could not load the bridge module: ${error.message}`);
      });
  });

  window.postMessage({ source: PAGE_SOURCE, kind: 'bridge-hello' }, '*');
})();
