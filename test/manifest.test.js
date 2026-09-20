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

describe('manifest.json', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('injects exactly the isolated relay and the MAIN-world bridge on the EA app', () => {
    expect(manifest.content_scripts).toHaveLength(2);
    expect(scriptFor('src/content.js').matches).toEqual([EA_MATCH]);
    expect(scriptFor('src/content.js').world).toBeUndefined();
    expect(scriptFor('src/page-bridge.js').matches).toEqual([EA_MATCH]);
    expect(scriptFor('src/page-bridge.js').world).toBe('MAIN');
  });

  it('runs both scripts at document_start', () => {
    for (const entry of manifest.content_scripts) {
      expect(entry.run_at).toBe('document_start');
    }
  });

  it('claims no permissions at all: the page makes its own authenticated calls', () => {
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_permissions ?? []).toEqual([]);
  });

  it('never matches all URLs', () => {
    expect(rawManifest).not.toContain('<all_urls>');
  });

  it('exposes the runtime assets only to the EA app', () => {
    expect(manifest.web_accessible_resources).toHaveLength(1);
    const [war] = manifest.web_accessible_resources;
    expect(war.matches).toEqual([EA_MATCH]);
    for (const resource of [
      'design/tokens.css',
      'design/copy.en.json',
      'design/copy.da.json',
      'src/ui/styles.css',
      'src/content-app.js',
      'src/page-bridge-app.js',
    ]) {
      expect(war.resources).toContain(resource);
    }
  });

  it('exposes every module the MAIN-world bridge imports', () => {
    const [war] = manifest.web_accessible_resources;
    for (const module of [
      'src/ea/adapter.js',
      'src/ea/build.js',
      'src/ea/challenge-reader.js',
      'src/ea/club-reader.js',
      'src/ea/summary.js',
      'src/ui/copy.js',
      'src/ui/messages.js',
      'src/ui/panel-mount.js',
      'src/ui/solve-button.js',
      'src/solver/candidates.js',
      'src/solver/prices.js',
    ]) {
      expect(war.resources).toContain(module);
    }
  });

  it('exposes the solver worker and every module it imports', () => {
    const [war] = manifest.web_accessible_resources;
    for (const module of [
      'src/solver/worker.js',
      'src/solver/worker-protocol.js',
      'src/solver/solve.js',
      'src/solver/validate.js',
      'src/solver/chemistry.js',
      'src/solver/requirements.js',
    ]) {
      expect(war.resources).toContain(module);
    }
  });

  it('lists every module reachable from the declared entry points', () => {
    const [war] = manifest.web_accessible_resources;
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
