/**
 * Injects the one M1 control: a primary Solve button, scoped under `.fsl-root`
 * and styled from `design/tokens.css` plus `src/ui/styles.css`.
 *
 * The button is the only user-visible surface in this milestone, so it follows
 * the design contract: `.fsl-root` wrapper, `.fsl-toolbar` row, one
 * `.fsl-btn-primary` action, label from the copy bundle. `document` is passed
 * in so this module is testable in Node with a fake DOM and contains no
 * module-level DOM access.
 *
 * Mounting is idempotent: the button carries `data-fsl-solve-button`, and a
 * mount finds and returns the existing button instead of adding a second one
 * when the panel re-renders.
 */

const BUTTON_ATTRIBUTE = 'data-fsl-solve-button';
const BUTTON_SELECTOR = `[${BUTTON_ATTRIBUTE}]`;

/**
 * @param {{ document: object, root: object, label: string, onClick: Function }} options
 * @returns {{ wrapper: object, toolbar: object, button: object, created: boolean }}
 *   `created` is false when an earlier mount's button was found
 * @throws {Error} when the mount root or the copy label is missing
 */
export function mountSolveButton({ document, root, label, onClick }) {
  if (root === null || root === undefined) {
    throw new Error('mountSolveButton: a panel mount root is required');
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('mountSolveButton: a non-empty copy label is required');
  }

  const existing = root.querySelector(BUTTON_SELECTOR);
  if (existing !== null && existing !== undefined) {
    const parent = existing.parentNode ?? root;
    return { wrapper: parent, toolbar: parent, button: existing, created: false };
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'fsl-root';

  const toolbar = document.createElement('div');
  toolbar.className = 'fsl-toolbar';

  const button = document.createElement('button');
  button.className = 'fsl-btn-primary';
  button.type = 'button';
  button.textContent = label;
  button.setAttribute(BUTTON_ATTRIBUTE, '');
  button.addEventListener('click', onClick);

  toolbar.appendChild(button);
  wrapper.appendChild(toolbar);
  root.appendChild(wrapper);

  return { wrapper, toolbar, button, created: true };
}
