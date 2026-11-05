import { describe, expect, it } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { DIAGNOSTIC_CATALOGUE } from '../src/solver/validate.js';
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

const flattenKeys = (value, prefix = '') =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? flattenKeys(child, path)
      : [path];
  });

const flattenStrings = (value, prefix = '') =>
  Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? flattenStrings(child, path)
      : [[path, child]];
  });

const placeholderNames = (value) =>
  [...value.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();

// The solver owns the diagnostic vocabulary: `DIAGNOSTIC_CATALOGUE` is built
// from the validator's own failure and unverified tables, so this test cannot
// drift from a new id or a changed param. Copy keys are the camelCase form of
// the id, exactly as the design contract lists them.
const copyKeyFor = (id) => id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

describe('copy bundle parity', () => {
  it('keeps an identical key set in Danish and English', () => {
    expect(flattenKeys(copyDa).sort()).toEqual(flattenKeys(copyEn).sort());
  });

  it('keeps identical placeholders for every shared key', () => {
    const danish = new Map(flattenStrings(copyDa));
    const english = new Map(flattenStrings(copyEn));

    for (const [path, englishText] of english) {
      expect(placeholderNames(danish.get(path)), path).toEqual(placeholderNames(englishText));
    }
  });
});

describe('solver diagnostics map to copy', () => {
  it('gives every catalogue id a copy key in both languages', () => {
    expect(Object.keys(DIAGNOSTIC_CATALOGUE).length).toBeGreaterThan(0);

    for (const id of Object.keys(DIAGNOSTIC_CATALOGUE)) {
      const path = `states.noSolution.${copyKeyFor(id)}`;
      for (const [locale, bundle] of Object.entries(BUNDLES)) {
        expect(() => readCopyPath(bundle, path), `${locale}:${id}`).not.toThrow();
      }
    }
  });

  it('matches every copy placeholder to the catalogue params', () => {
    for (const [id, params] of Object.entries(DIAGNOSTIC_CATALOGUE)) {
      const path = `states.noSolution.${copyKeyFor(id)}`;
      for (const [locale, bundle] of Object.entries(BUNDLES)) {
        expect(placeholderNames(readCopyPath(bundle, path)), `${locale}:${id}`).toEqual(
          [...params].sort()
        );
      }
    }
  });

  it('describes an unverified check without reusing the deficit wording', () => {
    const english = (key) => readCopyPath(copyEn, `states.noSolution.${key}`);
    const danish = (key) => readCopyPath(copyDa, `states.noSolution.${key}`);

    expect(english('ratingFormulaUnverified')).not.toBe(english('missingRating'));
    expect(danish('ratingFormulaUnverified')).not.toBe(danish('missingRating'));

    for (const key of [
      'qualityNotChecked',
      'playerLevelNotChecked',
      'ratingFormulaUnverified',
      'chemistryFormulaUnverified',
    ]) {
      expect(english(key), key).not.toMatch(/\b(short|missing)\b/i);
      expect(danish(key), key).not.toMatch(/\bmangler\b/i);
    }
  });
});
