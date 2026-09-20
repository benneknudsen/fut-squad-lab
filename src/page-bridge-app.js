/**
 * The MAIN-world half of the bridge. It runs as an ES module (dynamically
 * imported by the classic `src/page-bridge.js` bootstrap, because manifest
 * content scripts cannot use static imports), shares `window` with EA's code,
 * and is the only place that touches EA globals.
 *
 * Responsibilities:
 * - feature-detect `UTSBCSquadDetailPanelViewController` and patch its
 *   `initWithSBCSet` entry point (both names come from `src/ea/adapter.js`);
 * - mount the design-contract Solve button into the rendered panel once the
 *   copy label arrives from the isolated relay;
 * - on click, hand the panel subject to `src/ea/solve-service.js`, which reads
 *   the challenge and the club, solves through the Worker relay and writes the
 *   result through EA's own save path, then post the diagnostic summaries back;
 * - degrade to a clear message naming the missing symbol, never an unhandled
 *   throw: a renamed EA class is the expected failure mode here.
 *
 * The solver core is untouched: this module talks to it through the pure
 * modules and the isolated relay, never by running `solve` on the page.
 */

import {
  EA_GLOBALS,
  EA_PANEL_HOOK,
  formatEligibilityKeysLine,
  readEligibilityKeys,
  resolveEaGlobal,
} from './ea/adapter.js';
import { createSolveService } from './ea/solve-service.js';
import { createSolveTransport } from './ea/solve-transport.js';
import { buildMarker } from './ea/build.js';
import { buildDiagnosticsReport, buildSolveSummary, formatDiagnosticsBlock } from './ea/summary.js';
import { CONTENT_SOURCE, CONTENT_TO_PAGE_KINDS, PAGE_SOURCE, PAGE_TO_CONTENT_KINDS } from './ui/messages.js';
import { FALLBACK_VIA, describeMountShape, findPanelMount } from './ui/panel-mount.js';
import { mountSolveButton } from './ui/solve-button.js';

const DEFAULT_HOOK_POLL_MS = 500;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const PATCH_FLAG = '__fslPatchedBySquadLab';

/**
 * Starts the bridge in the page's `window`.
 *
 * @param {object} pageWindow the page `window`
 * @param {{ hookPollMs?: number, hookTimeoutMs?: number, pacer?: object }} [options]
 *   poll tuning; the defaults keep checking for a minute before reporting a
 *   missing class, because the SPA may load EA's bundle after this script.
 *   `pacer` is the queue every EA call runs through (#52); production omits it
 *   and the solve service owns a fresh paced queue
 */
export function startPageBridge(pageWindow, options = {}) {
  const hookPollMs = options.hookPollMs ?? DEFAULT_HOOK_POLL_MS;
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  const state = {
    label: null,
    controller: null,
    subject: null,
    busy: false,
    eligibilityRead: false,
    eligibility: null,
    eligibilityError: null,
    mount: null,
    diagnostics: null,
  };

  const post = (kind, payload = {}) =>
    pageWindow.postMessage({ source: PAGE_SOURCE, kind, ...payload }, '*');

  const reportError = (message) => post(PAGE_TO_CONTENT_KINDS.ERROR, { message });

  const transport = createSolveTransport({
    post: (message) => {
      const { kind, ...payload } = message;
      post(kind, payload);
    },
  });

  const service = createSolveService({
    pageWindow,
    requestSolve: (operation, payload) => transport.requestSolve(operation, payload),
    pacer: options.pacer,
    steps: {
      readEligibilityKeys: () => {
        if (state.eligibilityError !== null) throw state.eligibilityError;
        return state.eligibility;
      },
    },
  });

  /**
   * The extension's one diagnostic global, namespaced to avoid colliding with
   * anything EA owns. It returns the staged report of the most recent Solve —
   * counts, ids, stage outcomes and reason strings only, never item-level club
   * contents, player names, prices, account identifiers or session data — or
   * null before the first Solve, so it is always safe to paste into a support
   * report. Re-dump it with:
   *
   *   copy(JSON.stringify(window.__FSL_DIAGNOSE__(), null, 2))
   */
  pageWindow.__FSL_DIAGNOSE__ = () => state.diagnostics;

  /**
   * Resolves EA's live `SBCEligibilityKey` enum once per session and logs one
   * line a support report can paste. The table is cached on the session state
   * for the solve wiring to pass in as `options.keys`; the pinned observation
   * table is test data and production is structurally unable to reach it. A
   * missing or malformed enum is reported, not thrown: this is a read, and a
   * renamed EA symbol must stay observable rather than crash the bridge.
   */
  const resolveEligibilityOnce = () => {
    if (state.eligibilityRead) return state.eligibility;
    state.eligibilityRead = true;
    const log = pageWindow.console;
    try {
      state.eligibility = readEligibilityKeys(pageWindow);
      log?.info?.(formatEligibilityKeysLine(state.eligibility));
    } catch (error) {
      state.eligibility = null;
      state.eligibilityError = error;
      log?.info?.(`FUT Squad Lab: eligibility keys unreadable (${error.message})`);
    }
    return state.eligibility;
  };

  const ensureMounted = () => {
    if (state.controller === null || state.label === null) return;
    const { node, via } = findPanelMount(state.controller, pageWindow.document);
    if (node === null) {
      reportError(
        `no mount node found for ${EA_GLOBALS.squadDetailPanel}; the panel view shape may have` +
          ' changed'
      );
      return;
    }
    const fallback = via === FALLBACK_VIA;
    const mounted = mountSolveButton({
      document: pageWindow.document,
      root: node,
      label: state.label,
      fallback,
      onClick: () => {
        handleSolveClick().catch((error) => reportError(`read failed: ${error.message}`));
      },
    });
    // The diagnostic reports the route it took. When no panel view was
    // recognised the shape report names what the controller actually exposes,
    // so the real mount property can be found without another guessing round.
    state.mount = fallback
      ? describeMountShape(state.controller, mounted.button)
      : { fallback: false, via };
    if (mounted.created) {
      post(PAGE_TO_CONTENT_KINDS.MOUNTED, { via, message: `button mounted via ${via}` });
      return;
    }
    post(PAGE_TO_CONTENT_KINDS.BRIDGE_READY, { message: `button already mounted via ${via}` });
  };

  const handleSolveClick = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const outcome = await service.solve(state.subject);
      const diagnostics = buildDiagnosticsReport(
        outcome.stages,
        buildMarker(),
        outcome.pacing
      );
      state.diagnostics = { ...diagnostics, mount: state.mount };
      pageWindow.console?.log?.(formatDiagnosticsBlock(state.diagnostics));
      post(PAGE_TO_CONTENT_KINDS.SUMMARY, {
        summary: outcome.read.summary,
        challengeStrategy: outcome.read.challengeStrategy,
        challengeAttempts: outcome.read.challengeAttempts,
        clubStrategy: outcome.read.clubStrategy,
        clubAttempts: outcome.read.clubAttempts,
      });
      if (outcome.ok === false) {
        if (outcome.stage !== 'challenge' && outcome.error.name !== 'AbortError') {
          reportError(`solve failed (${outcome.stage}): ${outcome.error.message}`);
        }
        return;
      }
      post(PAGE_TO_CONTENT_KINDS.SUMMARY, {
        summary: buildSolveSummary({
          readSummary: outcome.read.summary,
          result: outcome,
          write: outcome.write,
        }),
      });
    } finally {
      state.busy = false;
    }
  };

  const onPanel = (controller, subject) => {
    if (state.subject !== subject) {
      transport.cancel();
      service.cancel();
    }
    state.controller = controller;
    state.subject = subject;
    resolveEligibilityOnce();
    ensureMounted();
  };

  const patchPanel = (Controller) => {
    if (typeof Controller !== 'function' || Controller.prototype === undefined) {
      reportError(`EA global ${EA_GLOBALS.squadDetailPanel} is not a constructor with a prototype`);
      return;
    }
    const entry = EA_PANEL_HOOK.entry;
    const original = Controller.prototype[entry];
    if (typeof original !== 'function') {
      reportError(
        `EA class ${EA_GLOBALS.squadDetailPanel} has no ${entry} method; cannot hook the SBC` +
          ' panel'
      );
      return;
    }
    if (original[PATCH_FLAG] === true) {
      post(PAGE_TO_CONTENT_KINDS.BRIDGE_READY, {
        message: `${EA_GLOBALS.squadDetailPanel}.${entry} already hooked`,
      });
      return;
    }
    const patched = function (...args) {
      const result = original.apply(this, args);
      try {
        onPanel(this, args[0]);
      } catch (error) {
        reportError(`panel hook failed: ${error.message}`);
      }
      return result;
    };
    patched[PATCH_FLAG] = true;
    Controller.prototype[entry] = patched;
    post(PAGE_TO_CONTENT_KINDS.BRIDGE_READY, {
      message: `hooked ${EA_GLOBALS.squadDetailPanel}.${entry}`,
    });
  };

  pageWindow.addEventListener('message', (event) => {
    if (event.source !== pageWindow) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== CONTENT_SOURCE) return;
    if (data.kind === CONTENT_TO_PAGE_KINDS.COPY) {
      if (typeof data.label === 'string' && data.label.length > 0) {
        state.label = data.label;
        ensureMounted();
      }
      return;
    }
    if (
      data.kind === CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE ||
      data.kind === CONTENT_TO_PAGE_KINDS.SOLVE_ERROR ||
      data.kind === CONTENT_TO_PAGE_KINDS.SOLVE_PROGRESS
    ) {
      transport.handle(data);
    }
  });

  pageWindow.addEventListener('pagehide', () => {
    service.cancel();
    transport.cancel();
  });

  const deadline = Date.now() + hookTimeoutMs;
  const poll = () => {
    const Controller = resolveEaGlobal(pageWindow, 'squadDetailPanel');
    if (Controller === null) {
      if (Date.now() >= deadline) {
        pageWindow.clearInterval(timer);
        reportError(
          `EA global ${EA_GLOBALS.squadDetailPanel} was not found on the page window after` +
            ` ${Math.round(hookTimeoutMs / 1000)}s; the FC27 web app may have renamed it`
        );
      }
      return;
    }
    pageWindow.clearInterval(timer);
    patchPanel(Controller);
  };
  const timer = pageWindow.setInterval(poll, hookPollMs);
  poll();

  post(PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO);
}
