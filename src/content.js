/**
 * Isolated-world bootstrap for the FUT Squad Lab relay.
 *
 * Manifest-declared content scripts are classic scripts and cannot use static
 * `import`, so this file dynamically imports `src/content-app.js` through
 * `chrome.runtime.getURL`. From that point the relay runs as a normal ES module
 * in the isolated world, where `chrome.*` and the copy bundles are available.
 * `crypto` is handed over rather than read inside the module: the isolated world
 * has the real one, and the relay mints this session's message nonce from it
 * (#88).
 */
(async () => {
  try {
    const relay = await import(chrome.runtime.getURL('src/content-app.js'));
    relay.startContentApp({ window, document, chrome, navigator, fetch, console, crypto });
  } catch (error) {
    console.error(`[FUT Squad Lab] content bootstrap failed: ${error.message}`);
  }
})();
