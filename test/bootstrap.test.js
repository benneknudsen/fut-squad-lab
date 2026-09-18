import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  PAGE_SOURCE,
} from '../src/ui/messages.js';

// The two manifest-declared entry scripts are classic scripts: they cannot use
// static imports, so their protocol constants are literals that must stay in
// step with `src/ui/messages.js`. These tests read the real files, so changing a
// tag on one side without the other fails here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGE_BRIDGE = 'src/page-bridge.js';
const CONTENT = 'src/content.js';

describe('main-world bootstrap', () => {
  it('uses the message contract tags from messages.js', () => {
    const source = read(PAGE_BRIDGE);
    expect(source).toContain(`'${PAGE_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE}'`);
  });

  it('imports exactly the bridge module named in the contract', () => {
    expect(read(PAGE_BRIDGE)).toContain(`'/${BRIDGE_MODULE_FILE}'`);
  });

  it('contains no static import or export statement', () => {
    const source = read(PAGE_BRIDGE);
    expect(source).not.toMatch(/^\s*import\s+(?!\()/m);
    expect(source).not.toMatch(/^\s*export\b/m);
  });
});

describe('isolated-world bootstrap', () => {
  it('loads the relay module through chrome.runtime.getURL', () => {
    expect(read(CONTENT)).toContain("chrome.runtime.getURL('src/content-app.js')");
  });

  it('contains no static import or export statement', () => {
    const source = read(CONTENT);
    expect(source).not.toMatch(/^\s*import\s+(?!\()/m);
    expect(source).not.toMatch(/^\s*export\b/m);
  });
});
