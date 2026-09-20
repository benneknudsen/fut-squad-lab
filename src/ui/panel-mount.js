/**
 * Finds the DOM node the Solve button can be mounted into, given the SBC detail
 * panel controller the bridge just hooked, and (issue #42) describes the
 * controller's shape when none of the known shapes match.
 *
 * EA's view class hierarchy is internal and undocumented: the controller may
 * expose the rendered panel as `view` (a DOM element or a wrapper with `.el`),
 * or as `el` / `$el`. The bridge feature-detects each shape and reports which
 * one answered. When none is recognised it falls back to a fixed-position
 * container at the document body, says so, and reports the controller's own
 * enumerable property names with a type signature each, `controller.view`'s
 * same when it is a non-element object, the prototype's method names, and the
 * mounted button's parent chain. That report is what finds the real mount
 * property on the live page without another guessing round.
 *
 * The shape report is diagnostics: names and signatures only. It never reads a
 * string's contents, an id, a price, an item or an account/session field, and
 * property names matching the paste-safety rules are redacted, because the
 * output is pasted into public support reports.
 *
 * `document` is passed in, so this module has no module-level DOM access and is
 * testable in Node with a fake element.
 */

/** The `via` reported when the mount falls back to the document body. */
export const FALLBACK_VIA = 'document.body (fallback)';

/** The schema id of the controller shape report emitted with diagnostics. */
export const MOUNT_SHAPE_SCHEMA = 'fsl-mount-shape/1';

const MAX_OBJECT_KEYS = 6;
const MAX_CLASS_NAMES = 6;
const MAX_PARENT_DEPTH = 32;
const MAX_PROTOTYPE_METHODS = 60;

/**
 * Names that must never be reported, matching the paste-safety rules the
 * diagnostics block already enforces: the report names EA's fields, so a
 * session, credential, club-item or price field must stay unnamed too.
 */
const SENSITIVE_NAME =
  /token|session|cookie|persona|credential|secret|authorization|itemData|assetId|marketAverage|discardValue|coin/i;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isElement = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.appendChild === 'function' &&
  typeof value.querySelector === 'function';

const redactName = (name) => (SENSITIVE_NAME.test(name) ? '<redacted>' : name);

const describeElement = (value) => {
  const tag =
    typeof value.tagName === 'string' && value.tagName.length > 0
      ? value.tagName.toLowerCase()
      : 'unknown';
  const classes =
    typeof value.className === 'string'
      ? value.className.trim().split(/\s+/).filter(Boolean).slice(0, MAX_CLASS_NAMES)
      : [];
  const classPart = classes.map((name) => `.${name}`).join(' ');
  return `ELEMENT <${tag}>${classPart.length > 0 ? ` ${classPart}` : ''}`;
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
 * an accessor is never invoked, so a controller getter cannot run or leak.
 *
 * @param {*} target the controller or view to describe
 * @returns {Array<string>} one entry per own enumerable property
 */
export function describeOwnProperties(target) {
  if (!isRecord(target)) return [];
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
 * spotted. Accessors are named but never invoked.
 *
 * @param {*} target the controller to describe
 * @returns {Array<string>} method names and `'name (getter)'` entries
 */
export function describePrototypeMethods(target) {
  if (target === null || typeof target !== 'object') return [];
  const names = new Set();
  let proto = Object.getPrototypeOf(target);
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
 * Describes where the mounted control actually landed: the element and every
 * ancestor up to the document root, each as an `ELEMENT <tag> .class` line.
 *
 * @param {*} element the `data-fsl-solve-button` element
 * @returns {Array<string>} the chain, nearest first, capped at
 *   `MAX_PARENT_DEPTH` entries
 */
export function describeParentChain(element) {
  const chain = [];
  const seen = new Set();
  let node = element ?? null;
  while (node !== null && chain.length < MAX_PARENT_DEPTH && !seen.has(node)) {
    seen.add(node);
    chain.push(describeValue(node));
    node = node.parentNode ?? null;
  }
  return chain;
}

/**
 * Builds the controller shape report emitted when `findPanelMount` falls back.
 * Shape only: names and signatures, no contents and no values.
 *
 * @param {object} controller the hooked `UTSBCSquadDetailPanelViewController`
 * @param {object} button the mounted `data-fsl-solve-button` element
 * @returns {{ schema: string, fallback: boolean, via: string, controller: {
 *   ownProperties: Array<string>, prototypeMethods: Array<string> },
 *   view: { ownProperties: Array<string> }|null, parentChain: Array<string> }}
 */
export function describeMountShape(controller, button) {
  const view = controller?.view;
  return {
    schema: MOUNT_SHAPE_SCHEMA,
    fallback: true,
    via: FALLBACK_VIA,
    controller: {
      ownProperties: describeOwnProperties(controller),
      prototypeMethods: describePrototypeMethods(controller),
    },
    view: isRecord(view) && !isElement(view) ? { ownProperties: describeOwnProperties(view) } : null,
    parentChain: describeParentChain(button),
  };
}

const CANDIDATES = Object.freeze([
  Object.freeze({ via: 'controller.view', read: (controller) => controller?.view }),
  Object.freeze({ via: 'controller.view.el', read: (controller) => controller?.view?.el }),
  Object.freeze({ via: 'controller.el', read: (controller) => controller?.el }),
  Object.freeze({ via: 'controller.$el', read: (controller) => controller?.$el }),
]);

/**
 * @param {object} controller the hooked `UTSBCSquadDetailPanelViewController`
 * @param {{ body?: object }} document the page document
 * @returns {{ node: object|null, via: string }} the mount node and how it was
 *   found; `via` is `FALLBACK_VIA` when no candidate matched but the body is
 *   an element, and `'none'` when there is nothing to mount into
 */
export function findPanelMount(controller, document) {
  for (const candidate of CANDIDATES) {
    const value = candidate.read(controller);
    if (isElement(value)) return { node: value, via: candidate.via };
  }
  const body = document?.body;
  if (isElement(body)) {
    return { node: body, via: FALLBACK_VIA };
  }
  return { node: null, via: 'none' };
}
