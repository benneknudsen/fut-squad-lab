import { describe, expect, it } from 'vitest';

import { findPanelMount } from '../src/ui/panel-mount.js';

// Plain object literals stand in for DOM nodes: the mount finder only needs the
// two methods an element must offer, so no jsdom is required.
const element = () => ({
  appendChild() {},
  querySelector() {
    return null;
  },
});

const fakeDocument = { body: element() };

describe('findPanelMount', () => {
  it('prefers the controller view when it is a DOM element', () => {
    const view = element();
    const found = findPanelMount({ view }, fakeDocument);
    expect(found.node).toBe(view);
    expect(found.via).toBe('controller.view');
  });

  it('falls back to common view wrappers', () => {
    const el = element();
    expect(findPanelMount({ view: { el } }, fakeDocument)).toEqual({
      node: el,
      via: 'controller.view.el',
    });
    expect(findPanelMount({ el }, fakeDocument)).toEqual({ node: el, via: 'controller.el' });
    expect(findPanelMount({ $el: el }, fakeDocument)).toEqual({ node: el, via: 'controller.$el' });
  });

  it('reports the document body when no view can be recognised', () => {
    const found = findPanelMount({}, fakeDocument);
    expect(found.node).toBe(fakeDocument.body);
    expect(found.via).toContain('document.body');
  });

  it('reports a null node when even the body is absent, instead of throwing', () => {
    const found = findPanelMount({}, {});
    expect(found.node).toBeNull();
    expect(found.via).toBe('none');
  });
});
