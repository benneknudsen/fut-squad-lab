/**
 * Content-free shape signatures for the diagnostics reports (#42, #44).
 *
 * EA's live objects (view controllers, service locators, class prototypes) are
 * internal and undocumented, so when a feature-detect fails the bridge reports
 * what the live object actually exposes: property names with a type signature
 * each, never a value. This module is that one implementation, shared by the
 * mount report in `src/ui/panel-mount.js` and the service and request surface
 * report in `src/ea/service-shape.js`, which lives in another layer and must
 * not import a `ui/` module.
 *
 * The output is pasted into public support reports, so the rules are:
 *
 * - a string is always `string("...")`, never its contents;
 * - property names matching the paste-safety rules are replaced by
 *   `<redacted>` rather than dropped, so "absent" and "hidden" stay
 *   distinguishable;
 * - an accessor is named as `accessor(get)` and never invoked, because a live
 *   getter may have side effects in the player's authenticated session.
 *
 * `SENSITIVE_NAME` is the one redaction list. Any module that reports a name
 * imports `redactName` from here; there is never a second copy to drift.
 *
 * This module is pure: plain objects in, plain strings out. No DOM access, no
 * `chrome.*` APIs, no network.
 */

const MAX_OBJECT_KEYS = 6;
const MAX_CLASS_NAMES = 6;
const MAX_PROTOTYPE_METHODS = 60;

/**
 * Names that must never be reported, matching the paste-safety rules the
 * diagnostics block enforces: the report names EA's fields, so a session,
 * credential, club-item or price field must stay unnamed too.
 */
const SENSITIVE_NAME =
  /token|session|cookie|persona|credential|secret|authorization|platform|price|itemData|assetId|marketAverage|discardValue|coin/i;

const REDACTED_NAME = '<redacted>';

/**
 * Replaces a name that must not be reported with `<redacted>`. It stays in the
 * output, so a reader can tell a hidden field from an absent one.
 *
 * @param {string} name a property or method name
 * @returns {string} the name, or `<redacted>`
 */
export const redactName = (name) => (SENSITIVE_NAME.test(name) ? REDACTED_NAME : name);

export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isElement = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.appendChild === 'function' &&
  typeof value.querySelector === 'function';

const describeElement = (value) => {
  const tag =
    typeof value.tagName === 'string' && value.tagName.length > 0
      ? value.tagName.toLowerCase()
      : 'unknown';
  const classes =
    typeof value.className === 'string'
      ? value.className.trim().split(/\s+/).filter(Boolean).slice(0, MAX_CLASS_NAMES)
      : [];
  const classPart = classes.map((name) => ` .${name}`).join('');
  return `ELEMENT <${tag}>${classPart}`;
};

/**
 * Describes a value in one short, content-free signature.
 *
 * @param {*} value any value
 * @returns {string} `'ELEMENT <div> .a.b'`, `'array[23]'`, `'obj{a,b,c}'`,
 *   `'string("...")'`, `'function'`, `'null'`, `'undefined'`, `'DOCUMENT'`,
 *   or the primitive's `typeof`
 */
export function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value.nodeType === 9) return 'DOCUMENT';
  if (isElement(value)) return describeElement(value);
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === 'function') return 'function';
  if (typeof value === 'string') return 'string("...")';
  if (typeof value === 'object') {
    const names = Object.keys(value);
    const shown = names.slice(0, MAX_OBJECT_KEYS).map(redactName).join(',');
    return `obj{${shown}${names.length > MAX_OBJECT_KEYS ? ',…' : ''}}`;
  }
  return typeof value;
}

/**
 * Lists every own enumerable property as `name: signature`. A property whose
 * value is another object contributes its first few key names after redaction;
 * an accessor is never invoked, so a live getter cannot run or leak. A function
 * is describable too, so a class constructor reports its static properties.
 *
 * @param {*} target the object or function to describe
 * @returns {Array<string>} one entry per own enumerable property
 */
export function describeOwnProperties(target) {
  if (!isRecord(target) && typeof target !== 'function') return [];
  return Object.keys(target).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor !== undefined && typeof descriptor.get === 'function') {
      return `${redactName(name)}: accessor(get)`;
    }
    let signature;
    try {
      signature = describeValue(target[name]);
    } catch {
      signature = 'unreadable';
    }
    return `${redactName(name)}: ${signature}`;
  });
}

/**
 * Names the prototype's methods, walking the chain up to (not including)
 * `Object.prototype`, so a method or getter that returns the view can be
 * spotted. A constructor function is accepted directly and contributes its
 * `prototype`'s methods. Accessors are named but never invoked.
 *
 * @param {*} target the object or constructor function to describe
 * @returns {Array<string>} method names and `'name (getter)'` entries
 */
export function describePrototypeMethods(target) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return [];
  const names = new Set();
  let proto =
    typeof target === 'function' ? (target.prototype ?? null) : Object.getPrototypeOf(target);
  while (proto !== null && proto !== Object.prototype && names.size < MAX_PROTOTYPE_METHODS) {
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(proto);
    } catch {
      break;
    }
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (name === 'constructor') continue;
      if (typeof descriptor.get === 'function') names.add(`${redactName(name)} (getter)`);
      else if (typeof descriptor.value === 'function') names.add(redactName(name));
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names].slice(0, MAX_PROTOTYPE_METHODS);
}