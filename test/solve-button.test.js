import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { panelLabel } from '../src/ui/copy.js';
import { mountSolveButton } from '../src/ui/solve-button.js';

// A hand-rolled fake document: the button module must be testable in Node with
// no jsdom, and the fake keeps the assertions on the elements the module really
// builds rather than on a DOM implementation.
const makeDocument = () => {
  const createElement = (tagName) => {
    const node = {
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      attributes: {},
      children: [],
      listeners: [],
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, handler) {
        this.listeners.push({ type, handler });
      },
      click() {
        for (const listener of this.listeners) {
          if (listener.type === 'click') listener.handler({ type: 'click' });
        }
      },
      querySelector(selector) {
        if (selector !== '[data-fsl-solve-button]') throw new Error(`unexpected selector ${selector}`);
        return findMarked(this);
      },
    };
    const findMarked = (candidate) => {
      if (Object.hasOwn(candidate.attributes, 'data-fsl-solve-button')) return candidate;
      for (const child of candidate.children) {
        const match = findMarked(child);
        if (match !== null) return match;
      }
      return null;
    };
    return node;
  };
  return { createElement };
};

const BUNDLES = { da: copyDa, en: copyEn };

describe('mountSolveButton', () => {
  it('mounts one scoped toolbar button under .fsl-root with the copy-bundle label', () => {
    const document = makeDocument();
    const root = document.createElement('div');
    const label = panelLabel(BUNDLES, 'da-DK');
    const mounted = mountSolveButton({ document, root, label, onClick: () => {} });

    expect(mounted.created).toBe(true);
    expect(root.children).toEqual([mounted.wrapper]);
    expect(mounted.wrapper.className).toBe('fsl-root');
    expect(mounted.wrapper.children).toEqual([mounted.toolbar]);
    expect(mounted.toolbar.className).toBe('fsl-toolbar');
    expect(mounted.toolbar.children).toEqual([mounted.button]);
    expect(mounted.button.className).toBe('fsl-btn-primary');
    expect(mounted.button.type).toBe('button');
    expect(mounted.button.textContent).toBe('Løs denne udfordring');
    expect(mounted.button.getAttribute('data-fsl-solve-button')).not.toBeNull();
  });

  it('is idempotent: a second mount does not inject a second button', () => {
    const document = makeDocument();
    const root = document.createElement('div');
    const label = panelLabel(BUNDLES, 'en-GB');
    const first = mountSolveButton({ document, root, label, onClick: () => {} });
    const second = mountSolveButton({ document, root, label, onClick: () => {} });

    expect(second.created).toBe(false);
    expect(second.button).toBe(first.button);
    expect(root.children).toHaveLength(1);
  });

  it('finds a button injected by an earlier mount after the wrapper was re-rendered', () => {
    const document = makeDocument();
    const firstRoot = document.createElement('div');
    const mounted = mountSolveButton({
      document,
      root: firstRoot,
      label: panelLabel(BUNDLES, 'en-GB'),
      onClick: () => {},
    });
    const secondRoot = document.createElement('div');
    secondRoot.appendChild(mounted.wrapper);
    const second = mountSolveButton({
      document,
      root: secondRoot,
      label: panelLabel(BUNDLES, 'da-DK'),
      onClick: () => {},
    });
    expect(second.created).toBe(false);
    expect(second.button).toBe(mounted.button);
    expect(secondRoot.children).toHaveLength(1);
    expect(second.button.textContent).toBe('Solve this challenge');
  });

  it('wires the click handler to the button', () => {
    const document = makeDocument();
    const root = document.createElement('div');
    const onClick = vi.fn();
    const mounted = mountSolveButton({ document, root, label: 'Solve this challenge', onClick });
    mounted.button.click();
    mounted.button.click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('requires a mount root and a copy label', () => {
    const document = makeDocument();
    expect(() =>
      mountSolveButton({ document, root: null, label: 'x', onClick: () => {} })
    ).toThrow(/root/);
    expect(() =>
      mountSolveButton({ document, root: document.createElement('div'), label: '', onClick: () => {} })
    ).toThrow(/label/);
  });
});
