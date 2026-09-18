/**
 * Locale selection and string lookup for the UI copy bundle.
 *
 * The design contract owns every user-visible string: `design/copy.en.json` and
 * `design/copy.da.json` are the two bundles, and nothing is hardcoded here or in
 * the injected UI. This module only decides which bundle a browser language maps
 * to and reads a dotted key out of it, so the language choice and the lookup are
 * unit-testable without `chrome.*` or a DOM.
 *
 * Danish is the default only for a `da*` language tag; every other tag —
 * including an unknown or missing one — falls back to English, matching the
 * design contract's stated behaviour.
 */

const DEFAULT_LOCALE = 'en';

/**
 * Maps a `navigator.language` value to a copy-bundle locale.
 *
 * `da`, `da-DK` and `DA-dk` all resolve to `da`; `dar` does not, because the
 * tag must end at or after the `da` prefix. Anything else resolves to `en`.
 *
 * @param {string|undefined|null} language a BCP 47 language tag
 * @returns {'da'|'en'}
 */
export function resolveCopyLocale(language) {
  if (typeof language !== 'string') return DEFAULT_LOCALE;
  return /^da([-_]|$)/i.test(language) ? 'da' : DEFAULT_LOCALE;
}

/**
 * Reads a nested dotted key from a copy bundle. A missing key throws naming the
 * full path: a silent `undefined` would end up as an unreadable button, and the
 * smoke test cannot catch a key this module swallowed.
 *
 * @param {object} bundle a parsed `copy.*.json`
 * @param {string} path dotted key, e.g. `panel.solve`
 * @returns {string} the copy string
 * @throws {Error} when any segment of the path is missing
 */
export function readCopyPath(bundle, path) {
  const segments = String(path).split('.');
  let value = bundle;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      throw new Error(`readCopyPath: copy bundle has no string at ${JSON.stringify(path)}`);
    }
    value = value[segment];
  }
  if (typeof value !== 'string') {
    throw new Error(`readCopyPath: ${JSON.stringify(path)} is not a string`);
  }
  return value;
}

/**
 * The primary-action label for the injected button, per the design contract's
 * `panel.solve` key.
 *
 * @param {{ da: object, en: object }} bundles the parsed copy bundles by locale
 * @param {string|undefined|null} language a BCP 47 language tag
 * @returns {string} the label for the selected bundle
 */
export function panelLabel(bundles, language) {
  return readCopyPath(bundles[resolveCopyLocale(language)], 'panel.solve');
}
