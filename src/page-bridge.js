/**
 * MAIN-world bootstrap for the FUT Squad Lab bridge.
 *
 * Manifest-declared content scripts are classic scripts: they cannot use static
 * `import`, and the MAIN world has no `chrome.*` APIs to resolve an extension
 * URL. So this file does the minimum a MAIN-world script must do itself — learn
 * its own extension id from `document.currentScript`, listen for the relay's
 * message, validate the module URL against that id and dynamically import
 * `src/page-bridge-app.js` — and all real logic lives in that ES module.
 *
 * The tag literals below mirror `src/ui/messages.js`; the two files cannot
 * import each other, so `test/bootstrap.test.js` locks them together and tests
 * the URL gate below. The same rule lives there as `isBridgeModuleUrl(url,
 * extensionId)`; keep the two in step.
 */
(() => {
  const PAGE_SOURCE = 'fsl-page';
  const CONTENT_SOURCE = 'fsl-content';
  const BRIDGE_MODULE_KIND = 'bridge-module';
  const BRIDGE_MODULE_SUFFIX = '/src/page-bridge-app.js';
  const CHROME_EXTENSION_PREFIX = 'chrome-extension://';

  const extensionIdFromScriptUrl = (url) => {
    if (typeof url !== 'string' || !url.startsWith(CHROME_EXTENSION_PREFIX)) return null;
    const rest = url.slice(CHROME_EXTENSION_PREFIX.length);
    const slash = rest.indexOf('/');
    return slash > 0 ? rest.slice(0, slash) : null;
  };

  const extensionOrigin = (url) => {
    if (typeof url !== 'string') return 'a non-string URL';
    if (!url.startsWith(CHROME_EXTENSION_PREFIX)) return 'a non-extension URL';
    const rest = url.slice(CHROME_EXTENSION_PREFIX.length);
    const slash = rest.indexOf('/');
    return `${CHROME_EXTENSION_PREFIX}${slash === -1 ? rest : rest.slice(0, slash)}`;
  };

  // `document.currentScript` is only readable during synchronous evaluation, so
  // capture it before any listener can run. A page cannot change it mid-script;
  // if it is missing or not an extension URL, every module message is refused
  // rather than trusting an unidentified origin.
  const ownScriptUrl = document.currentScript && document.currentScript.src;
  const ownExtensionId = extensionIdFromScriptUrl(ownScriptUrl);
  const ownModulePrefix =
    ownExtensionId === null ? null : `${CHROME_EXTENSION_PREFIX}${ownExtensionId}/`;

  let started = false;

  const report = (message) =>
    window.postMessage({ source: PAGE_SOURCE, kind: 'error', message }, '*');

  const isOwnBridgeModuleUrl = (url) =>
    ownModulePrefix !== null &&
    typeof url === 'string' &&
    url.startsWith(ownModulePrefix) &&
    url.endsWith(BRIDGE_MODULE_SUFFIX);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== CONTENT_SOURCE) return;
    if (data.kind !== BRIDGE_MODULE_KIND || started) return;
    if (!isOwnBridgeModuleUrl(data.url)) {
      const reason =
        ownModulePrefix === null
          ? 'this extension could not determine its own id'
          : `expected ${ownModulePrefix}${BRIDGE_MODULE_SUFFIX.slice(1)}`;
      report(`refused bridge module URL ${extensionOrigin(data.url)}; ${reason}`);
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
