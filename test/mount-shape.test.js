import { describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_VIA,
  MOUNT_SHAPE_SCHEMA,
  describeMountShape,
  describeParentChain,
  findPanelMount,
} from '../src/ui/panel-mount.js';
import { startPageBridge } from '../src/page-bridge-app.js';

// A plain-object DOM with a tagName and a parentNode, so the shape report is
// exercised without jsdom and the assertions are on what the module really
// emits: signatures of the values the bridge actually sees.
const createFakeNode = (tagName = 'div') => {
  const node = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    attributes: {},
    children: [],
    parentNode: null,
    listeners: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = this;
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
      const scan = (candidate) => {
        if (Object.hasOwn(candidate.attributes, 'data-fsl-solve-button')) return candidate;
        for (const child of candidate.children) {
          const match = scan(child);
          if (match !== null) return match;
        }
        return null;
      };
      return scan(this);
    },
  };
  return node;
};

const createFakeDocument = () => ({
  createElement: (tagName) => createFakeNode(tagName),
  body: createFakeNode('body'),
});

const noisyController = (extra = {}) => ({
  subject: { elgReq: [] },
  rows: [1, 2, 3],
  render: () => {},
  ...extra,
});

const shapeOf = (controller) => describeMountShape(controller, createFakeNode('button'));

describe('findPanelMount still resolves the four documented candidates', () => {
  it('mounts through each candidate even when the controller carries unrelated own properties', () => {
    const element = createFakeNode('section');
    element.className = 'sbc-panel';
    const document = createFakeDocument();
    const cases = [
      ['controller.view', noisyController({ view: element })],
      ['controller.view.el', noisyController({ view: { el: element } })],
      ['controller.el', noisyController({ el: element })],
      ['controller.$el', noisyController({ $el: element })],
    ];

    for (const [via, controller] of cases) {
      const found = findPanelMount(controller, document);
      expect(found.node).toBe(element);
      expect(found.via).toBe(via);
    }
  });

  it('names the fallback route explicitly when every candidate is absent', () => {
    const document = createFakeDocument();
    const found = findPanelMount(noisyController(), document);

    expect(found.node).toBe(document.body);
    expect(found.via).toBe('document.body (fallback)');
    expect(FALLBACK_VIA).toBe('document.body (fallback)');
  });
});

describe('describeMountShape', () => {
  it('identifies an own property that is a DOM node as an element with its tag', () => {
    const panel = createFakeNode('div');
    panel.className = 'sbc-panel sbc-panel--wide';
    const shape = shapeOf({ mountPoint: panel });

    expect(shape.controller.ownProperties).toContain(
      'mountPoint: ELEMENT <div> .sbc-panel .sbc-panel--wide'
    );
  });

  it('signs off every value shape without emitting a single value', () => {
    const shape = shapeOf({
      nested: { alpha: 1, beta: 2 },
      list: [1, 2, 3],
      handler: () => {},
      missing: undefined,
      absent: null,
      label: 'do not print me',
    });

    expect(shape.controller.ownProperties).toEqual([
      'nested: obj{alpha,beta}',
      'list: array[3]',
      'handler: function',
      'missing: undefined',
      'absent: null',
      'label: string("...")',
    ]);
    expect(JSON.stringify(shape)).not.toContain('do not print me');
  });

  it('reports the own properties of the view when it is a non-element object', () => {
    const shape = shapeOf({ view: { el: null, name: 'x' } });

    expect(shape.view).toEqual({ ownProperties: ['el: null', 'name: string("...")'] });
  });

  it('reports prototype method names, including a getter that could return the view', () => {
    function Controller() {
      this.rows = [];
    }
    Controller.prototype.initWithSBCSet = function () {};
    Object.defineProperty(Controller.prototype, 'panelView', {
      get() {
        return null;
      },
    });

    const shape = shapeOf(new Controller());

    expect(shape.controller.prototypeMethods).toContain('initWithSBCSet');
    expect(shape.controller.prototypeMethods).toContain('panelView (getter)');
  });

  it('reports the actual parent chain of the mounted button', () => {
    const document = createFakeDocument();
    const wrapper = document.createElement('div');
    wrapper.className = 'fsl-root';
    const toolbar = document.createElement('div');
    toolbar.className = 'fsl-toolbar';
    const button = document.createElement('button');
    button.className = 'fsl-btn-primary';
    toolbar.appendChild(button);
    wrapper.appendChild(toolbar);
    document.body.appendChild(wrapper);

    expect(describeParentChain(button)).toEqual([
      'ELEMENT <button> .fsl-btn-primary',
      'ELEMENT <div> .fsl-toolbar',
      'ELEMENT <div> .fsl-root',
      'ELEMENT <body>',
    ]);
  });

  it('carries its own schema id and says that it is the fallback', () => {
    const shape = shapeOf(noisyController());

    expect(shape.schema).toBe(MOUNT_SHAPE_SCHEMA);
    expect(shape.fallback).toBe(true);
  });
});

describe('the shape report leaks nothing', () => {
  it('redacts the names and never reads the values the paste-safety rules exclude', () => {
    const shape = shapeOf({
      sessionToken: 'live-session-secret',
      personaId: 987654321,
      itemData: [
        { id: 123456, assetId: 654321, name: 'Placeholder Player', marketAverage: 9000 },
      ],
      coinBalance: 12345,
      panel: null,
    });
    const json = JSON.stringify(shape);

    expect(json).not.toContain('live-session-secret');
    expect(json).not.toContain('Placeholder Player');
    expect(json).not.toContain('123456');
    expect(json).not.toContain('987654321');
    expect(json).not.toContain('12345');
    expect(json).not.toMatch(
      /token|session|cookie|persona|credential|secret|authorization|itemData|assetId|marketAverage|discardValue|coin/i
    );
    expect(shape.controller.ownProperties.some((entry) => entry.startsWith('<redacted>'))).toBe(
      true
    );
  });
});

// The MAIN-world bridge, with a controller that exposes none of the four
// candidates, so the mount really takes the fallback route it must report.
const createFallbackWindow = () => {
  const document = createFakeDocument();
  const messages = [];
  const listeners = [];

  function UTSBCSquadDetailPanelViewController() {
    this.rows = [null, null];
  }
  UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function (subject) {
    this.subject = subject;
    return 'original result';
  };

  const pageWindow = {
    document,
    console: { log: vi.fn(), info: vi.fn(), warn: vi.fn() },
    services: { UTSBCRepository: { getClubItems: async () => ({ itemData: [] }) } },
    UTSBCSquadDetailPanelViewController,
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    setInterval(handler, ms) {
      return setInterval(handler, ms);
    },
    clearInterval(id) {
      clearInterval(id);
    },
  };

  return {
    pageWindow,
    document,
    messages,
    dispatchMessage(data, source = pageWindow) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const COPY_MESSAGE = {
  source: 'fsl-content',
  kind: 'copy',
  locale: 'en',
  label: 'Solve this challenge',
};

describe('the page bridge fallback mount', () => {
  it('mounts the control in the tree under .fsl-root and reports the fallback route', () => {
    const { pageWindow, document, messages, dispatchMessage } = createFallbackWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);

    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet('subject');

    const wrapper = document.body.children[0];
    expect(wrapper).toBeDefined();
    expect(wrapper.className).toBe('fsl-root');
    expect(wrapper.parentNode).toBe(document.body);
    expect(wrapper.getAttribute('data-fsl-fallback')).not.toBeNull();
    const button = wrapper.children[0].children[0];
    expect(button.getAttribute('data-fsl-solve-button')).not.toBeNull();

    const mounted = messages.find((message) => message.kind === 'mounted');
    expect(mounted.via).toBe('document.body (fallback)');
    expect(mounted.message).toBe('button mounted via document.body (fallback)');
  });

  it('carries the controller shape into the diagnostic report', async () => {
    const { pageWindow, document, dispatchMessage } = createFallbackWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);

    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet('not a challenge');

    const button = document.body.children[0].children[0].children[0];
    button.click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    expect(report.mount).toMatchObject({ fallback: true, via: 'document.body (fallback)' });
    expect(report.mount.controller.ownProperties).toContain('rows: array[2]');
    expect(report.mount.parentChain).toContain('ELEMENT <div> .fsl-root');
    expect(report.schema).toBe('fsl-diagnostics/1');
  });
});