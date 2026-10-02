import { describe, expect, it } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  NONCE_BYTES,
  NONCE_FIELD,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
  CONTENT_TO_PAGE_KINDS,
  formatNonce,
  isBridgeModuleUrl,
  nonceMatches,
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

describe('formatNonce', () => {
  it('renders bytes as lowercase hex, one byte per two characters', () => {
    expect(formatNonce(Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
  });

  it('pads every byte to two characters so a leading zero survives', () => {
    expect(formatNonce(Uint8Array.from([0x01, 0x02]))).toBe('0102');
  });

  it('mints 16 bytes of entropy, which is 32 hex characters on the wire', () => {
    expect(NONCE_BYTES).toBe(16);
    expect(formatNonce(new Uint8Array(NONCE_BYTES))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects anything that is not a byte array instead of inventing a nonce', () => {
    expect(() => formatNonce('000102030405060708090a0b0c0d0e0f')).toThrow(/Uint8Array/);
    expect(() => formatNonce(undefined)).toThrow(/Uint8Array/);
  });
});

describe('nonceMatches', () => {
  const NONCE = '000102030405060708090a0b0c0d0e0f';

  it('names the field every message carries the nonce in', () => {
    expect(NONCE_FIELD).toBe('nonce');
  });

  it('accepts the exact nonce it was minted with', () => {
    expect(nonceMatches(NONCE, NONCE)).toBe(true);
  });

  it('rejects a nonce that differs anywhere, including the first character', () => {
    expect(nonceMatches(NONCE, `100102030405060708090a0b0c0d0e0f`)).toBe(false);
    expect(nonceMatches(NONCE, `000102030405060708090a0b0c0d0e00`)).toBe(false);
    expect(nonceMatches(NONCE, `${NONCE}0`)).toBe(false);
    expect(nonceMatches(NONCE, NONCE.slice(1))).toBe(false);
  });

  it('is case sensitive, so an upper-cased copy of the nonce is not the nonce', () => {
    expect(nonceMatches(NONCE, NONCE.toUpperCase())).toBe(false);
  });

  it('rejects a value that is not a string, whatever it coerces to', () => {
    for (const candidate of [undefined, null, 0, 1, true, {}, [], NONCE.split('')]) {
      expect(nonceMatches(NONCE, candidate)).toBe(false);
    }
  });

  it('fails closed when the listener has no nonce of its own', () => {
    for (const expected of [undefined, null, '', 42, {}]) {
      expect(nonceMatches(expected, NONCE)).toBe(false);
    }
    expect(nonceMatches(undefined, undefined)).toBe(false);
    expect(nonceMatches('', '')).toBe(false);
  });

  it('compares every character instead of returning early, so the guess cannot leak', () => {
    // The only black-box way to see an early return is to count the characters
    // the compare looks at: `===` on two strings looks at none, a `startsWith`
    // or a `some` that stops at the first difference looks at only some.
    const expected = 'aaaaaaaa';
    const real = String.prototype.charCodeAt;
    const compared = (candidate) => {
      let calls = 0;
      String.prototype.charCodeAt = function counted(index) {
        calls += 1;
        return real.call(this, index);
      };
      try {
        nonceMatches(expected, candidate);
      } finally {
        String.prototype.charCodeAt = real;
      }
      return calls;
    };
    // Where the first wrong character sits must not be observable, and the
    // whole value must be walked: `===` looks at nothing, `every`/`some` and
    // `startsWith` stop at the first difference.
    const wrongFirst = compared('baaaaaaa');
    const wrongLast = compared('aaaaaaab');
    expect(wrongFirst).toBe(wrongLast);
    expect(wrongFirst).toBeGreaterThan(expected.length);
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

  it('rejects any path that is not the module path, including a traversal out of one', () => {
    // A suffix check admits every one of these, because they all end in the
    // module path: the gate has to be on the whole path, not on its tail.
    for (const path of [
      '../src/page-bridge-app.js',
      'src/../src/page-bridge-app.js',
      'src/ui/../page-bridge-app.js',
      'assets/src/page-bridge-app.js',
      // The `use_dynamic_url` shape is a replaced host, not a `_/` path segment
      // (`TransformToDynamicURLIfNecessary` swaps the host and keeps the path),
      // so no path of ours may carry one either.
      '_/src/page-bridge-app.js',
    ]) {
      expect(isBridgeModuleUrl(`chrome-extension://${OWN_ID}/${path}`, OWN_ID)).toBe(false);
    }
  });

  it('pins the extension id character for character, not just the scheme', () => {
    // #85's whole point. If the id comparison were dropped in favour of "some
    // chrome-extension host", every one of these would be admitted.
    const nearMissId = `x${OWN_ID.slice(1)}`;
    expect(
      isBridgeModuleUrl(`chrome-extension://${nearMissId}/${BRIDGE_MODULE_FILE}`, OWN_ID),
    ).toBe(false);
    // And the refusal is the id pin, not something else: the same URL is
    // accepted under its own id, so only the comparison can be responsible.
    expect(
      isBridgeModuleUrl(`chrome-extension://${nearMissId}/${BRIDGE_MODULE_FILE}`, nearMissId),
    ).toBe(true);
  });
});
