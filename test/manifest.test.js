import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findUnlistedModules } from './helpers/import-graph.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const rawManifest = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EA_MATCH = 'https://www.ea.com/*';
const scriptFor = (jsPath) =>
  manifest.content_scripts.find((entry) => entry.js.includes(jsPath));

const [war] = manifest.web_accessible_resources;
const exposedResources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);

/** Every one of these is a resource the page must be able to load. */
const expectExposed = (...resources) => {
  for (const resource of resources) expect(war.resources).toContain(resource);
};

describe('manifest.json', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('injects the isolated relay on the EA app and nothing else', () => {
    // #105: the MAIN-world loader is not declared here any more, and that is the
    // point of the change rather than an accident. Chrome creates no `<script>`
    // element for a manifest-declared MAIN-world content script, so
    // `document.currentScript` is `null` in it — the loader could not resolve its
    // own extension id, and #85's gate refused every message including the relay's
    // own. The isolated relay injects it instead, as a real element. If this ever
    // grows a `world: "MAIN"` entry again, the loader has no id again.
    expect(manifest.content_scripts).toHaveLength(1);
    expect(scriptFor('src/content.js').matches).toEqual([EA_MATCH]);
    expect(scriptFor('src/content.js').world).toBeUndefined();
    expect(scriptFor('src/page-bridge.js')).toBeUndefined();
    expect(
      manifest.content_scripts.filter((entry) => entry.world !== undefined),
    ).toEqual([]);
  });

  it('runs the isolated relay at document_start', () => {
    expect(scriptFor('src/content.js').run_at).toBe('document_start');
  });

  it('claims no permissions at all: the page makes its own authenticated calls', () => {
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_permissions ?? []).toEqual([]);
  });

  it('never matches all URLs', () => {
    expect(rawManifest).not.toContain('<all_urls>');
  });

  it('states the extension-page CSP rather than inheriting the MV3 default', () => {
    // The value is exactly MV3's default. The point of writing it out is that a
    // reviewer can read the guarantee instead of having to know the default, and
    // so that a future edit which loosens it shows up in this diff.
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'",
    });
  });

  it('exposes the runtime assets only to the EA app', () => {
    expect(manifest.web_accessible_resources).toHaveLength(1);
    expect(war.matches).toEqual([EA_MATCH]);
    // #105: the MAIN-world loader is a web-accessible resource now, because the
    // page is what has to be able to load it. One entry, and it is the loader
    // and nothing else — this is the only file the injection added.
    expectExposed(
      'design/tokens.css',
      'design/copy.en.json',
      'design/copy.da.json',
      'src/ui/styles.css',
      'src/content-app.js',
      'src/page-bridge.js',
      'src/page-bridge-app.js',
    );
  });

  it('exposes no captured payload fixture to the page', () => {
    // `test/fixtures/` holds real captures off a live club, sanitised. They are
    // not loaded at runtime and must never become fetchable from EA's page.
    const exposed = exposedResources.filter((resource) =>
      /(?:^|\/)test\/fixtures\//.test(resource),
    );

    expect(exposed, 'web_accessible_resources must not expose a test fixture').toEqual([]);
  });

  it('exposes only extension-root-relative paths, so no entry can reach outside the package', () => {
    const exposed = exposedResources.filter(
      (resource) => resource.startsWith('/') || resource.split('/').includes('..'),
    );

    expect(exposed, 'web_accessible_resources must be relative to the extension root').toEqual([]);
  });

  it('serves the MAIN-world module graph from the static origin, not a dynamic one', () => {
    // `use_dynamic_url: true` does not put a prefix on the path. Chromium
    // replaces the URL's *host* with the extension's per-installation GUID
    // (`WebAccessibleResourcesInfo::IsResourceWebAccessible` accepts a dynamic
    // resource only when `extension.guid() == target_url.host()`), so the URL
    // becomes `chrome-extension://<guid>/src/page-bridge-app.js`.
    //
    // #105 moved where the loader's id comes from, and with it this reasoning. The
    // id is read from the `<script>` element the relay injects, and that element is
    // now a web-accessible resource — so a dynamic URL would hand the loader the
    // GUID while the relay hands over the static id from `chrome.runtime.getURL`,
    // and the pin in `src/page-bridge.js` would refuse every message again. Same
    // conclusion as #89 reached, and the same reason: the two sides of the gate
    // have to agree on which host names this extension. See #98 for the switch.
    for (const entry of manifest.web_accessible_resources) {
      expect(entry.use_dynamic_url ?? false).toBe(false);
    }
  });

  it('exposes every module the MAIN-world bridge imports', () => {
    expectExposed(
      'src/ea/adapter.js',
      'src/ea/build.js',
      'src/ea/challenge-reader.js',
      'src/ea/club-reader.js',
      'src/ea/observer.js',
      'src/ea/summary.js',
      'src/ui/copy.js',
      'src/ui/messages.js',
      'src/ui/panel-mount.js',
      'src/ui/solve-button.js',
      'src/solver/candidates.js',
      'src/solver/prices.js',
    );
  });

  it('exposes the solver worker and every module it imports', () => {
    expectExposed(
      'src/solver/worker.js',
      'src/solver/worker-protocol.js',
      'src/solver/solve.js',
      'src/solver/validate.js',
      'src/solver/chemistry.js',
      'src/solver/requirements.js',
    );
  });

  it('lists every module reachable from the declared entry points', () => {
    const entryPoints = [
      ...manifest.content_scripts.flatMap((entry) => entry.js),
      ...war.resources,
    ];
    const missing = findUnlistedModules({
      root: repoRoot,
      entries: entryPoints,
      listed: entryPoints,
    });

    expect(
      missing,
      'reachable modules missing from web_accessible_resources.resources',
    ).toEqual([]);
  });

  it('points the icons at files that exist', () => {
    for (const size of ['16', '32', '48', '128']) {
      const icon = manifest.icons[size];
      expect(icon).toContain(`-${size}.png`);
      expect(existsSync(new URL(`../${icon}`, import.meta.url))).toBe(true);
    }
  });
});
