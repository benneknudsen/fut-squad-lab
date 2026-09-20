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
 * The most source characters one method excerpt may carry. A signature fits
 * well inside this; a body that does not is cut and the cut is named.
 */
export const METHOD_SOURCE_CAP = 300;

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
 * Lists every own enumerable property as `{ name, type }`, and for a string
 * whether it is empty, without ever carrying a value into the output:
 *
 *   { name: 'filters', type: 'object' }
 *   { name: 'label',   type: 'string', empty: false }
 *   { name: 'count',   type: 'undefined' }
 *
 * `undefined` and `null` get their own type instead of being flattened, so a
 * caller can tell "the field is missing" from "the field holds no value". An
 * accessor is named `accessor(get)` and never invoked, because this runs in the
 * player's authenticated session. Names go through the one redaction list, so a
 * field whose name matches `SENSITIVE_NAME` stays visible as `<redacted>` and is
 * never confused with an absent one.
 *
 * @param {*} target the object to describe
 * @returns {Array<{name: string, type: string, empty?: boolean}>} one entry per
 *   own enumerable property, in key order
 */
export function describeOwnPropertyTypes(target) {
  if (!isRecord(target) && typeof target !== 'function') return [];
  return Object.keys(target).map((name) => {
    const redacted = redactName(name);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(target, name);
    } catch {
      return { name: redacted, type: 'unreadable' };
    }
    if (descriptor !== undefined && typeof descriptor.get === 'function') {
      return { name: redacted, type: 'accessor(get)' };
    }
    const value = descriptor?.value;
    if (value === undefined) return { name: redacted, type: 'undefined' };
    if (value === null) return { name: redacted, type: 'null' };
    if (typeof value === 'string') {
      return { name: redacted, type: 'string', empty: value.length === 0 };
    }
    if (Array.isArray(value)) return { name: redacted, type: `array[${value.length}]` };
    if (typeof value === 'object') return { name: redacted, type: 'object' };
    return { name: redacted, type: typeof value };
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

/**
 * Reads a data property along an object's prototype chain without ever running
 * an accessor. A getter is a live value in the player's session; describing a
 * method must not have the side effect of calling it.
 */
const readFunctionProperty = (target, name) => {
  let current = target;
  while (current !== null && current !== undefined) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
    } catch {
      return undefined;
    }
    if (descriptor !== undefined) {
      return descriptor.get === undefined ? descriptor.value : undefined;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Replaces the contents of every string and template literal in a source
 * excerpt with `...`, keeping the quotes. The excerpt exists to show a
 * parameter list, so identifier and numeric-default information survives,
 * while a literal value in the source — a token, an id, a marker — cannot
 * reach the pasted report.
 */
const redactSourceLiterals = (source) => {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      output += char;
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === '\\' ? 2 : 1;
      }
      output += '...';
      if (index < source.length) {
        output += char;
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
};

/**
 * Describes how a resolved method wants to be called, so a wrong call shape
 * can be corrected from one live report instead of a guessed round: its
 * declared arity (`fn.length`), the name of its constructor (an async method
 * reports `AsyncFunction`), and a capped excerpt of its source.
 *
 * The excerpt is EA's code and appears in runtime diagnostics only. Its string
 * and template literal contents are replaced with `...` before it is emitted,
 * because a literal is a value, not a signature; a truncated excerpt names how
 * many characters were cut, and an unreadable source is dropped with that
 * reason rather than reported as absent. No accessor is invoked: arity and
 * constructor come from property descriptors.
 *
 * @param {*} fn the resolved method
 * @returns {{ arity: number|null, constructor: string|null, excerpt: string|null,
 *   truncated?: boolean, excerptReason?: string }}
 */
export function describeMethodShape(fn) {
  const arity = readFunctionProperty(fn, 'length');
  const constructor = readFunctionProperty(fn, 'constructor');
  const constructorName = readFunctionProperty(constructor, 'name');
  const shape = {
    arity: Number.isInteger(arity) && arity >= 0 ? arity : null,
    constructor:
      typeof constructorName === 'string' && constructorName.length > 0
        ? constructorName
        : null,
  };

  let source;
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    source = null;
  }
  if (typeof source !== 'string' || source.length === 0) {
    return { ...shape, excerpt: null, excerptReason: 'source unreadable' };
  }

  const redacted = redactSourceLiterals(source);
  if (redacted.length <= METHOD_SOURCE_CAP) {
    return { ...shape, excerpt: redacted, truncated: false };
  }
  const cutLength = redacted.length - METHOD_SOURCE_CAP;
  return {
    ...shape,
    excerpt: `${redacted.slice(0, METHOD_SOURCE_CAP)}…[truncated ${cutLength} chars]`,
    truncated: true,
  };
}
