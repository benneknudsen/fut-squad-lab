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
 * output is pasted into public support reports. The shape helpers and the one
 * redaction list live in `src/shape.js`, shared with the service surface report
 * (#44), so no second copy can drift.
 *
 * `document` is passed in, so this module has no module-level DOM access and is
 * testable in Node with a fake element.
 */

import {
  describeOwnProperties,
  describePrototypeMethods,
  describeValue,
  isElement,
  isRecord,
} from '../shape.js';

/** The `via` reported when the mount falls back to the document body. */
export const FALLBACK_VIA = 'document.body (fallback)';

/** The schema id of the controller shape report emitted with diagnostics. */
export const MOUNT_SHAPE_SCHEMA = 'fsl-mount-shape/1';

const MAX_PARENT_DEPTH = 32;

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