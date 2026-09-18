import { describe, expect, it } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { panelLabel, readCopyPath, resolveCopyLocale } from '../src/ui/copy.js';

// The design bundle is the copy contract: these tests read the real files, so a
// change to `panel.solve` in either language is caught here rather than shipped
// as a hardcoded string.
const BUNDLES = { da: copyDa, en: copyEn };

describe('resolveCopyLocale', () => {
  it('selects Danish for any da* navigator language', () => {
    expect(resolveCopyLocale('da')).toBe('da');
    expect(resolveCopyLocale('da-DK')).toBe('da');
    expect(resolveCopyLocale('DA-dk')).toBe('da');
  });

  it('selects English for en-GB, an unknown locale and a missing language', () => {
    expect(resolveCopyLocale('en-GB')).toBe('en');
    expect(resolveCopyLocale('fr-FR')).toBe('en');
    expect(resolveCopyLocale('')).toBe('en');
    expect(resolveCopyLocale(undefined)).toBe('en');
  });

  it('does not treat a language that merely starts with "da" as Danish', () => {
    expect(resolveCopyLocale('dar')).toBe('en');
  });
});

describe('readCopyPath', () => {
  it('reads a nested dotted key', () => {
    expect(readCopyPath(copyEn, 'panel.solve')).toBe('Solve this challenge');
    expect(readCopyPath(copyDa, 'panel.solve')).toBe('Løs denne udfordring');
  });

  it('throws naming the missing key instead of returning undefined', () => {
    expect(() => readCopyPath(copyEn, 'panel.doesNotExist')).toThrow(/panel\.doesNotExist/);
    expect(() => readCopyPath(copyEn, 'noSuchGroup.key')).toThrow(/noSuchGroup\.key/);
  });
});

describe('panelLabel', () => {
  it('returns the Danish solve label for a Danish browser', () => {
    expect(panelLabel(BUNDLES, 'da-DK')).toBe('Løs denne udfordring');
  });

  it('returns the English solve label for en-GB and for an unknown locale', () => {
    expect(panelLabel(BUNDLES, 'en-GB')).toBe('Solve this challenge');
    expect(panelLabel(BUNDLES, 'pt-BR')).toBe('Solve this challenge');
  });

  it('never returns a hardcoded fallback when the bundle lacks the key', () => {
    expect(() => panelLabel({ da: {}, en: {} }, 'en-GB')).toThrow(/panel\.solve/);
  });
});
