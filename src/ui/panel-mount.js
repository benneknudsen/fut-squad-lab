/**
 * Finds the DOM node the Solve button can be mounted into, given the SBC detail
 * panel controller the bridge just hooked.
 *
 * EA's view class hierarchy is internal and undocumented: the controller may
 * expose the rendered panel as `view` (a DOM element or a wrapper with `.el`),
 * or as `el` / `$el`. The bridge feature-detects each shape and reports which
 * one answered, so the manual test can say where the button landed. When none
 * is recognised it falls back to the document body and says so.
 *
 * `document` is passed in, so this module has no module-level DOM access and is
 * testable in Node with a fake element.
 */

const isElement = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.appendChild === 'function' &&
  typeof value.querySelector === 'function';

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
 *   found; `via` is `'none'` when there is nothing to mount into
 */
export function findPanelMount(controller, document) {
  for (const candidate of CANDIDATES) {
    const value = candidate.read(controller);
    if (isElement(value)) return { node: value, via: candidate.via };
  }
  const body = document?.body;
  if (isElement(body)) {
    return { node: body, via: 'document.body (no panel view recognised)' };
  }
  return { node: null, via: 'none' };
}
