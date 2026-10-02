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
  OBSERVED_CRITERIA_VALUE_FIELDS,
  diffClubSearchCriteria,
  formatEligibilityKeysLine,
  readEligibilityKeys,
  resolveEaGlobal,
  resolveObservationTargets,
} from './ea/adapter.js';
import { createSolveService } from './ea/solve-service.js';
import { createSolveTransport } from './ea/solve-transport.js';
import { buildMarker } from './ea/build.js';
import { createMethodObserver, formatObserverCall } from './ea/observer.js';
import {
  buildDiagnosticsReport,
  buildSolveSummary,
  formatDiagnosticsBlock,
  formatDiagnosticsFileName,
} from './ea/summary.js';
import {
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  NONCE_FIELD,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
  nonceMatches,
} from './ui/messages.js';
import { FALLBACK_VIA, describeMountShape, findPanelMount } from './ui/panel-mount.js';
import { mountSolveButton } from './ui/solve-button.js';

const DEFAULT_HOOK_POLL_MS = 500;
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const PATCH_FLAG = '__fslPatchedBySquadLab';

/** The console group the #64 observer logs every captured EA call into. */
const OBSERVER_GROUP_TITLE = 'FUT Squad Lab — observed EA calls';

/**
 * Writes the diagnostics report to the user's Downloads folder with a `Blob`
 * and a synthetic `<a download>` click (#75). The MAIN world already owns the
 * report, so the evidence file needs no permission, no background round-trip
 * and no extension API. It throws when the page cannot provide the pieces the
 * write needs, or when the synthetic anchor cannot be clicked; the caller
 * records that as the report's `download: { ok: false, reason }` instead of
 * swallowing it.
 *
 * @param {object} pageWindow the page `window`
 * @param {string} fileName the exact name, from `formatDiagnosticsFileName`
 * @param {object} report the exact `__FSL_DIAGNOSE__()` object: report, mount
 *   and download outcome
 * @throws {Error} when the page has no `Blob`, no `document.createElement` or
 *   no `URL.createObjectURL`, or when the anchor has no `click`
 */
export function writeDiagnosticsFile(pageWindow, fileName, report) {
  const BlobCtor = pageWindow?.Blob;
  const document = pageWindow?.document;
  const urlApi = pageWindow?.URL;
  if (typeof BlobCtor !== 'function') {
    throw new Error('the page has no Blob constructor');
  }
  if (document === null || document === undefined || typeof document.createElement !== 'function') {
    throw new Error('the page has no document.createElement');
  }
  if (urlApi === null || urlApi === undefined || typeof urlApi.createObjectURL !== 'function') {
    throw new Error('the page has no URL.createObjectURL');
  }
  const href = urlApi.createObjectURL(
    new BlobCtor([JSON.stringify(report, null, 2)], { type: 'application/json' })
  );
  try {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    if (typeof anchor.click !== 'function') {
      throw new Error('the page cannot click a download anchor');
    }
    const parent = document.body ?? null;
    if (parent !== null && typeof parent.appendChild === 'function') parent.appendChild(anchor);
    anchor.click();
    if (parent !== null && typeof anchor.remove === 'function') anchor.remove();
  } finally {
    if (typeof urlApi.revokeObjectURL === 'function') urlApi.revokeObjectURL(href);
  }
}

/**
 * Starts the bridge in the page's `window`.
 *
 * @param {object} pageWindow the page `window`
 * @param {{ nonce?: string, hookPollMs?: number, hookTimeoutMs?: number,
 *   pacer?: object }} [options] `nonce` is this session's message nonce, handed
 *   over by the classic `src/page-bridge.js` bootstrap after it checked the
 *   bridge-module message that carried it. It is required: the source tag on a
 *   message is a literal any page script can write, so the nonce is the part of
 *   a message that has to be right (#88), and a caller that has none — a page
 *   script that imports this module itself — gets a bridge that answers nothing.
 *   The remaining options are poll tuning; the defaults keep checking for a
 *   minute before reporting a missing class, because the SPA may load EA's
 *   bundle after this script. `pacer` is the queue every EA call runs through
 *   (#52); production omits it and the solve service owns a fresh paced queue
 */
export function startPageBridge(pageWindow, options = {}) {
  const hookPollMs = options.hookPollMs ?? DEFAULT_HOOK_POLL_MS;
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const nonce = typeof options.nonce === 'string' && options.nonce.length > 0 ? options.nonce : null;

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
    observerGrouped: false,
  };

  // #88: the one `post` choke point every message to the isolated world goes
  // through, so the nonce cannot be forgotten on a new kind. It is spread last,
  // so a payload cannot override or drop it. A bridge started without a nonce
  // posts `nonce: null`, which the relay's compare rejects: an unauthenticated
  // instance of this module is inert rather than a second bridge on the channel.
  const post = (kind, payload = {}) =>
    pageWindow.postMessage({ source: PAGE_SOURCE, kind, ...payload, [NONCE_FIELD]: nonce }, '*');

  const reportError = (message) => post(PAGE_TO_CONTENT_KINDS.ERROR, { message });

  /**
   * The #64 observer: read-only, wraps EA's own club methods and the panel
   * hook, records how EA called them, and returns every result unchanged. The
   * captures are logged into one console group as they happen and carried in
   * the diagnostics report. Values are recorded only for the adapter's
   * allowlist; everything else is a name and a type.
   */
  const observer = createMethodObserver({
    valueFields: OBSERVED_CRITERIA_VALUE_FIELDS,
    onCall: (record) => {
      try {
        const log = pageWindow.console;
        if (!state.observerGrouped) {
          state.observerGrouped = true;
          log?.group?.(OBSERVER_GROUP_TITLE);
        }
        log?.log?.(formatObserverCall(record));
      } catch {
        // Instrumentation must never break the call it observes.
      }
    },
  });

  /**
   * Installs the observer on whatever targets this page exposes right now.
   * Idempotent, and never throws: it is instrumentation, so a missing EA
   * symbol must not affect the bridge or the player's session.
   */
  const installObservation = () => {
    try {
      observer.install(resolveObservationTargets(pageWindow).targets);
    } catch {
      // A read-only observer must never be able to lose the bridge.
    }
  };

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
   * table is test data and production is structurally unable to reach it.
   * A missing global resolves the adapter's labelled fallback and the log line
   * says `source=fallback`; a malformed enum is reported, not thrown: this is a
   * read, and a renamed EA symbol must stay observable rather than crash the
   * bridge.
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
      const observerReport = observer.report();
      // #76: the diff compares EA's own observed club search criteria with the
      // criteria this build actually handed over, taken from the club stage's
      // record. It is part of the report even when the club read never ran.
      const clubDetail = outcome.stages.find((stage) => stage.id === 'club')?.detail ?? null;
      const criteriaDiff = diffClubSearchCriteria(
        observerReport,
        clubDetail?.criteria?.setFields ?? []
      );
      const diagnostics = buildDiagnosticsReport(
        outcome.stages,
        buildMarker(),
        outcome.pacing,
        observerReport,
        criteriaDiff
      );
      // #75 / #87: the report object the global returns is the staged report
      // plus the mount shape and the download outcome. A successful Solve
      // writes nothing: the user needs no evidence, and a file per Solve would
      // leave a behavioural record in the Downloads folder. A failed Solve is
      // exactly where the evidence file earns its existence, so only then does
      // the bridge attempt the write. `download: null` is the third state: no
      // write was attempted, as opposed to attempted and blocked, which is
      // recorded inside the report itself and never swallowed.
      state.diagnostics = { ...diagnostics, mount: state.mount, download: null };
      if (diagnostics.ok === false) {
        const file = formatDiagnosticsFileName(diagnostics.build.id);
        state.diagnostics = { ...state.diagnostics, download: { ok: true, file } };
        try {
          writeDiagnosticsFile(pageWindow, file, state.diagnostics);
        } catch (error) {
          state.diagnostics = {
            ...state.diagnostics,
            download: { ok: false, reason: error.message },
          };
        }
      }
      const block = formatDiagnosticsBlock(state.diagnostics);
      pageWindow.console?.log?.(block);
      post(PAGE_TO_CONTENT_KINDS.DIAGNOSTICS, {
        block,
        file: state.diagnostics.download?.ok === true ? state.diagnostics.download.file : null,
        download: state.diagnostics.download,
      });
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
    // A panel hook firing means EA's app is up; wrap anything that appeared
    // after the last install attempt. Idempotent.
    installObservation();
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
    // #88: nothing from the relay is acted on before the session nonce checks
    // out — not the copy label, and not a `bridge-module` message either, on top
    // of the URL gate the classic bootstrap already applies. A message that
    // arrives before the nonce is known, or that carries the wrong one, is
    // dropped here rather than buffered and rather than reported: the handshake
    // retries itself, and a dropped forgery is not an error condition.
    if (!nonceMatches(nonce, data[NONCE_FIELD])) return;
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
    // Never leave an observer wrapper installed: restore EA's own functions
    // and close the console group the captures opened.
    observer.remove();
    if (state.observerGrouped) {
      state.observerGrouped = false;
      pageWindow.console?.groupEnd?.();
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
    // Patch first, then observe, so the observer wraps our hook and can
    // restore it on teardown without unwrapping the button patch.
    installObservation();
  };
  const timer = pageWindow.setInterval(poll, hookPollMs);
  poll();

  post(PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO);
}
