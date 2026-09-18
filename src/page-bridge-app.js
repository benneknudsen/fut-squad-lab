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
 * - on click, read the challenge and the club through the adapter and readers,
 *   then post the diagnostic summary back;
 * - degrade to a clear message naming the missing symbol, never an unhandled
 *   throw: a renamed EA class is the expected failure mode here.
 *
 * The solver core is untouched: this module imports pure readers only.
 */

import {
  EA_GLOBALS,
  EA_PANEL_HOOK,
  formatEligibilityKeysLine,
  readEligibilityKeys,
  resolveChallengeSubject,
  resolveClubItems,
  resolveEaGlobal,
} from './ea/adapter.js';
import { readChallenge } from './ea/challenge-reader.js';
import { readClubItems } from './ea/club-reader.js';
import { buildReadSummary } from './ea/summary.js';
import { CONTENT_SOURCE, CONTENT_TO_PAGE_KINDS, PAGE_SOURCE, PAGE_TO_CONTENT_KINDS } from './ui/messages.js';
import { findPanelMount } from './ui/panel-mount.js';
import { mountSolveButton } from './ui/solve-button.js';

const DEFAULT_HOOK_POLL_MS = 500;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const PATCH_FLAG = '__fslPatchedBySquadLab';

/**
 * Starts the bridge in the page's `window`.
 *
 * @param {object} pageWindow the page `window`
 * @param {{ hookPollMs?: number, hookTimeoutMs?: number }} [options] poll
 *   tuning; the defaults keep checking for a minute before reporting a missing
 *   class, because the SPA may load EA's bundle after this script
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
  };

  const post = (kind, payload = {}) =>
    pageWindow.postMessage({ source: PAGE_SOURCE, kind, ...payload }, '*');

  const reportError = (message) => post(PAGE_TO_CONTENT_KINDS.ERROR, { message });

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
    const mounted = mountSolveButton({
      document: pageWindow.document,
      root: node,
      label: state.label,
      onClick: () => {
        handleSolveClick().catch((error) => reportError(`read failed: ${error.message}`));
      },
    });
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
      const subjectResult = resolveChallengeSubject(state.subject);
      const challenge = subjectResult.ok ? readChallenge(subjectResult.payload) : null;
      const clubResult = await resolveClubItems(pageWindow);
      const clubItems = clubResult.ok ? readClubItems(clubResult.items) : [];
      const summary = buildReadSummary({
        challenge,
        clubResult: clubResult.ok ? { ...clubResult, items: clubItems } : clubResult,
      });
      post(PAGE_TO_CONTENT_KINDS.SUMMARY, {
        summary,
        challengeStrategy: subjectResult.strategy,
        challengeAttempts: subjectResult.attempts,
        clubStrategy: clubResult.strategy,
        clubAttempts: clubResult.attempts,
      });
    } finally {
      state.busy = false;
    }
  };

  const onPanel = (controller, subject) => {
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
    }
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
