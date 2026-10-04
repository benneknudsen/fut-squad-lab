import { describe, expect, it, vi } from 'vitest';

import { BUILD_ID } from '../src/ea/build.js';
import { startPageBridge } from '../src/page-bridge-app.js';
import { OWN_EXTENSION_ID, OWN_MODULE_URL } from './helpers/bootstrap.js';
import { TEST_NONCE } from './helpers/nonce.js';
import { createChannel, startLoader, startRelay } from './helpers/channel.js';

// Issue #102: one line per stage of the bootstrap, so a pasted console log says
// which stage the boot reached and which one it did not. Every assertion here is
// on the exact line, in the exact position: a line that appeared on every boot
// regardless of what happened would prove nothing, so each of them has a
// negative twin below it.

// The exact text of every stage line, spelled out rather than composed from the
// production helpers: a test that rebuilt the expected string out of the same
// function it is testing would pass whatever that function did.
const BUILDING = '[FUT Squad Lab] build fsl-build/14 booting';
const RELAY_READY = '[FUT Squad Lab] content relay ready';
const HANDSHAKE_SENT = '[FUT Squad Lab] bridge module handshake sent';
const HELLO_ACKED = '[FUT Squad Lab] loader acknowledged bridge-hello';
const MODULE_LOADED = '[FUT Squad Lab] bridge module loaded';
const HOOK_FOUND = '[FUT Squad Lab] panel hook found';
const HOOK_NOT_FOUND = '[FUT Squad Lab] panel hook not found';
const OBSERVER_INSTALLED = '[FUT Squad Lab] observer installed';
const READY = '[FUT Squad Lab] ready';

const PANEL_GLOBAL = 'UTSBCSquadDetailPanelViewController';

const startBridge = (channel, options = {}) =>
  startPageBridge(channel.window, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20, ...options });

/**
 * Both worlds on one page, in production order, until the module has reported
 * itself. #105 fixed that order: the isolated relay is a manifest content script
 * and boots first, and it is the relay that injects the MAIN-world loader, so the
 * loader's body cannot run before the relay has booted. Its hello line therefore
 * lands after the relay's own three.
 */
const bootBothWorlds = async (channel) => {
  startRelay(channel);
  startLoader(channel);
  await channel.settle();
  await vi.waitFor(() => {
    expect(channel.logged).toContain(MODULE_LOADED);
  });
  await channel.settle();
};

/** Runs the hook poll to its deadline without waiting for it in real time. */
const withFakeTimers = (run) => {
  vi.useFakeTimers();
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
};

describe('the isolated relay boot log', () => {
  it('writes the build marker, the ready relay and the handshake once each, in that order', () => {
    const channel = createChannel();

    startRelay(channel);

    expect(channel.logged).toEqual([BUILDING, RELAY_READY, HANDSHAKE_SENT]);
  });

  it('names the build it booted, from the compiled-in marker rather than a literal', () => {
    const channel = createChannel();

    startRelay(channel);

    expect(channel.logged[0]).toContain(BUILD_ID);
    expect(channel.logged[0]).toBe(BUILDING);
  });

  it('writes nothing from the MAIN world until the injected loader has run', () => {
    // #105: injecting the loader is not the same as running it. A browser fetches
    // the element and evaluates it on a later turn, so the relay's boot completes
    // with the loader still pending — and a log that claimed the loader's line here
    // would be claiming something that has not happened.
    const channel = createChannel();

    startRelay(channel);

    expect(channel.injectedScripts.map((script) => script.src)).toEqual([
      `chrome-extension://${OWN_EXTENSION_ID}/src/page-bridge.js`,
    ]);
    expect(channel.logged).not.toContain(HELLO_ACKED);
  });

  it('says the loader did not run when the page refuses the injected script', () => {
    // The one new way this boot can fail with nothing on the console: the page's
    // own CSP refusing the extension origin, or the file not being served. Without
    // this line it is indistinguishable from a boot that is still waiting.
    const channel = createChannel();

    startRelay(channel);
    channel.injectedScripts[0].onerror();

    expect(channel.warned).toEqual([
      `[FUT Squad Lab] main-world loader did not run: ` +
        `chrome-extension://${OWN_EXTENSION_ID}/src/page-bridge.js was refused or not found`,
    ]);
    expect(channel.logged).not.toContain(HELLO_ACKED);
  });

  it('writes no second handshake line when the loader asks again with its hello', () => {
    // The stage completed once, when the relay put the module URL on the channel by
    // itself. Answering the loader's hello is the same stage, so it must not add a
    // line: a boot log that repeats is one nobody reads.
    const channel = createChannel();
    startRelay(channel);

    channel.post({ source: 'fsl-page', kind: 'bridge-hello' });
    channel.drain();

    expect(channel.logged).toEqual([BUILDING, RELAY_READY, HANDSHAKE_SENT]);
  });

  it('writes nothing at all when the relay never starts', () => {
    // The negative twin of every line above: a page this extension never injected
    // has an empty console, which is what "not booted" looks like.
    const channel = createChannel();

    expect(channel.logged).toEqual([]);
    expect(channel.warned).toEqual([]);
  });
});

describe('the MAIN-world module boot log', () => {
  it('writes panel hook found, observer installed and ready once each, in that order', () => {
    const channel = createChannel();

    startBridge(channel);

    expect(channel.logged).toEqual([HOOK_FOUND, OBSERVER_INSTALLED, READY]);
  });

  it('names the timeout and the global it waited for when EA never exposes the panel class', () => {
    // The one line that separates "EA renamed a class" from every other failure,
    // and the failure a first live run is most likely to hit.
    withFakeTimers(() => {
      const channel = createChannel({ withController: false });

      startBridge(channel, { hookPollMs: 50, hookTimeoutMs: 1500 });
      expect(channel.logged).toEqual([READY]);

      vi.advanceTimersByTime(2000);

      expect(channel.logged).toEqual([
        READY,
        `[FUT Squad Lab] panel hook not found: timed out after 2s waiting for ${PANEL_GLOBAL}`,
      ]);
    });
  });

  it('writes no panel-hook-found line when the class exists without the method to patch', () => {
    const channel = createChannel({ withHook: false });

    startBridge(channel);

    expect(channel.logged).toEqual([HOOK_NOT_FOUND, OBSERVER_INSTALLED, READY]);
  });

  it('writes no panel-hook-found line when the resolved global is not a constructor', () => {
    const channel = createChannel();
    channel.window[PANEL_GLOBAL] = { prototype: undefined };

    startBridge(channel);

    expect(channel.logged).toEqual([HOOK_NOT_FOUND, OBSERVER_INSTALLED, READY]);
  });

  it('reports a failed observer install instead of claiming the observer is installed', () => {
    // `installObservation` is instrumentation and swallows its own failure, so
    // without this line a broken one is indistinguishable from a working one.
    const channel = createChannel();
    Object.defineProperty(channel.window, 'services', {
      configurable: true,
      get() {
        throw new Error('EA replaced the services global');
      },
    });

    startBridge(channel);

    expect(channel.logged).toEqual([
      HOOK_FOUND,
      '[FUT Squad Lab] observer install failed: EA replaced the services global',
      READY,
    ]);
  });
});

describe('the classic MAIN-world loader boot log', () => {
  /** What the relay puts on the channel: this extension's own module URL. */
  const moduleMessage = () => ({
    source: 'fsl-content',
    kind: 'bridge-module',
    nonce: TEST_NONCE,
    url: OWN_MODULE_URL,
  });

  it('writes the hello line when it announces itself, and the module line once the module is loaded', async () => {
    const channel = createChannel();

    // #105: the loader can only exist because the relay injected it, so the
    // relay always goes first. Production order, and the only order.
    startRelay(channel);
    startLoader(channel);
    expect(channel.logged).toEqual([BUILDING, RELAY_READY, HANDSHAKE_SENT, HELLO_ACKED]);

    channel.post(moduleMessage());
    channel.drain();
    await vi.waitFor(() => {
      expect(channel.logged).toContain(MODULE_LOADED);
    });

    // The loader's line comes after the module's own stages: it reports the
    // stage that is complete once the module has both loaded and been started.
    expect(channel.logged.slice(0, 8)).toEqual([
      BUILDING,
      RELAY_READY,
      HANDSHAKE_SENT,
      HELLO_ACKED,
      HOOK_FOUND,
      OBSERVER_INSTALLED,
      READY,
      MODULE_LOADED,
    ]);
  });

  it('writes no module line when the import fails, and says why it failed', async () => {
    const channel = createChannel();
    startRelay(channel);
    startLoader(channel, {
      importModule: async () => {
        throw new Error('the module is not on disk');
      },
    });

    channel.post(moduleMessage());
    channel.drain();
    await vi.waitFor(() => {
      expect(channel.warned.join('\n')).toContain('the module is not on disk');
    });

    expect(channel.logged).not.toContain(MODULE_LOADED);
  });
});

describe('one boot, one console: both worlds on the same page window', () => {
  it('writes every boot stage exactly once, in the order the stages complete', async () => {
    const channel = createChannel();

    await bootBothWorlds(channel);

    expect(channel.logged).toEqual([
      BUILDING,
      RELAY_READY,
      HANDSHAKE_SENT,
      HELLO_ACKED,
      HOOK_FOUND,
      OBSERVER_INSTALLED,
      READY,
      MODULE_LOADED,
      `[FUT Squad Lab] hooked ${PANEL_GLOBAL}.initWithSBCSet`,
    ]);
  });

  it('reports the mount once the panel is open, with no second copy of the line', async () => {
    // The mount line is the MAIN world's own post, relayed by the relay — which
    // is why the bridge does not also write it locally.
    const channel = createChannel();

    await bootBothWorlds(channel);

    expect(channel.logged.some((line) => line.includes('button mounted'))).toBe(false);

    // EA opens the panel, which is what fires the hook the button hangs off.
    channel.openPanel();
    channel.drain();

    expect(channel.mountedButton()?.textContent).toBe('Solve this challenge');
    expect(channel.logged.filter((line) => line.includes('button mounted'))).toEqual([
      '[FUT Squad Lab] button mounted via controller.view',
    ]);
  });

  it('carries a MAIN-world error to the relay console, so a refused hook is not silent', async () => {
    const channel = createChannel({ withHook: false });

    startRelay(channel);
    startLoader(channel);
    await channel.settle();
    await vi.waitFor(() => {
      expect(channel.warned).toHaveLength(1);
    });

    expect(channel.warned).toEqual([
      `[FUT Squad Lab] EA class ${PANEL_GLOBAL} has no initWithSBCSet method; cannot hook the SBC` +
        ' panel',
    ]);
    expect(channel.logged).not.toContain(HOOK_FOUND);
  });

  it('keeps the session nonce out of every line of the boot log', async () => {
    const channel = createChannel();

    await bootBothWorlds(channel);
    channel.openPanel();
    channel.drain();

    // Anti-vacuity: the log must actually have content for this to mean
    // anything, and the nonce is in scope here — the relay minted TEST_NONCE.
    expect(channel.logged.length).toBeGreaterThan(5);
    expect(channel.logged.join('\n')).not.toContain(TEST_NONCE);
    expect(channel.warned.join('\n')).not.toContain(TEST_NONCE);
  });

  it('keeps the nonce out of the boot log on the timing-out path too', () => {
    withFakeTimers(() => {
      const channel = createChannel({ withController: false });

      startBridge(channel, { hookPollMs: 50, hookTimeoutMs: 1500 });
      vi.advanceTimersByTime(2000);

      expect(channel.logged).toHaveLength(2);
      expect(channel.logged.join('\n')).not.toContain(TEST_NONCE);
    });
  });
});
