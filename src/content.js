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
 *
 * #102: the console prefix lives in `src/ui/messages.js`, which this classic
 * script cannot import — so the log helper is loaded here, ahead of the relay,
 * and the one line that says why the boot stopped goes through it. The fallback
 * covers the one failure this file cannot report any other way: the helper's own
 * import failing.
 */
(async () => {
  let report = (line) => console.error(line);
  try {
    const { createBootLog } = await import(chrome.runtime.getURL('src/ui/messages.js'));
    report = createBootLog(console);
    const relay = await import(chrome.runtime.getURL('src/content-app.js'));
    relay.startContentApp({ window, document, chrome, navigator, fetch, console, crypto });
  } catch (error) {
    report(`content bootstrap failed: ${error.message}`);
  }
})();
