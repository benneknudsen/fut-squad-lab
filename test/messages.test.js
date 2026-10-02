import { describe, expect, it } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
  CONTENT_TO_PAGE_KINDS,
  isBridgeModuleUrl,
} from '../src/ui/messages.js';

describe('message contract', () => {
  it('namespaces the two worlds so a page script cannot be mistaken for the relay', () => {
    expect(PAGE_SOURCE).toBe('fsl-page');
    expect(CONTENT_SOURCE).toBe('fsl-content');
  });

  it('freezes the kind vocabulary for both directions', () => {
    expect(Object.isFrozen(PAGE_TO_CONTENT_KINDS)).toBe(true);
    expect(Object.isFrozen(CONTENT_TO_PAGE_KINDS)).toBe(true);
    expect(PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO).toBe('bridge-hello');
    expect(PAGE_TO_CONTENT_KINDS.SUMMARY).toBe('summary');
    expect(CONTENT_TO_PAGE_KINDS.COPY).toBe('copy');
    expect(CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE).toBe('bridge-module');
  });
});

describe('isBridgeModuleUrl', () => {
  const OWN_ID = 'abcdefghijklmnopabcdefghijklmnop';
  const OWN_URL = `chrome-extension://${OWN_ID}/${BRIDGE_MODULE_FILE}`;

  it('accepts the extension URL of the bridge module', () => {
    expect(isBridgeModuleUrl(OWN_URL, OWN_ID)).toBe(true);
  });

  it('rejects the same module URL under a different extension id', () => {
    expect(isBridgeModuleUrl(OWN_URL, 'ponmlkjihgfedcbaponmlkjihgfedcba')).toBe(false);
  });

  it('rejects a page-supplied URL, even a plausible one', () => {
    expect(isBridgeModuleUrl('https://evil.example/src/page-bridge-app.js', OWN_ID)).toBe(false);
    expect(isBridgeModuleUrl('http://127.0.0.1:8123/src/page-bridge-app.js', OWN_ID)).toBe(false);
    expect(isBridgeModuleUrl('data:text/javascript,export const x = 1', OWN_ID)).toBe(false);
  });

  it('rejects a different extension file and a missing URL', () => {
    expect(isBridgeModuleUrl(`chrome-extension://${OWN_ID}/src/other.js`, OWN_ID)).toBe(false);
    expect(isBridgeModuleUrl(undefined, OWN_ID)).toBe(false);
    expect(isBridgeModuleUrl(null, OWN_ID)).toBe(false);
    expect(isBridgeModuleUrl(42, OWN_ID)).toBe(false);
  });

  it('fails closed when the caller cannot name its own extension id', () => {
    expect(isBridgeModuleUrl(OWN_URL)).toBe(false);
    expect(isBridgeModuleUrl(OWN_URL, '')).toBe(false);
    expect(isBridgeModuleUrl(OWN_URL, null)).toBe(false);
    expect(isBridgeModuleUrl(OWN_URL, 42)).toBe(false);
  });

  it('rejects a suffix that only ends like the module path', () => {
    expect(isBridgeModuleUrl(`chrome-extension://${OWN_ID}/not-src/page-bridge-app.js`, OWN_ID)).toBe(
      false
    );
  });
});
