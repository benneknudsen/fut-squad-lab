import { describe, expect, it, vi } from 'vitest';

import { BUILD_ID } from '../src/ea/build.js';
import { startPageBridge } from '../src/page-bridge-app.js';
import { TEST_NONCE } from './helpers/nonce.js';
import { createChannel, startLoader, startRelay, OWN_MODULE_URL } from './helpers/channel.js';

// Issue #102: one line per stage of the bootstrap, so a pasted console log says
// which stage the boot reached and which one it did not. Every assertion here is
// on the exact line, in the exact position: a line that appeared on every boot
// regardless of what happened would prove nothing, so each of them has a
// negative twin below it.

// The exact text of every stage line, spelled out rather than composed from the
// production helpers: a test that rebuilt the expected string out of the same
// function it is testing would pass whatever that function did.
const BUILDING = '[FUT Squad Lab] build fsl-build/13 booting';
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

  it('writes no second handshake line when the loader asks again with its hello', () => {
    // The stage completed once, when the relay put the module URL on the
    // channel by itself. Answering the loader's hello is the same stage, so it
    // must not add a line: a boot log that repeats is one nobody reads.
    const channel = createChannel();
    startRelay(channel);

    channel.post({ source: 'fsl-page', kind: 'bridge-hello' });
    channel.drain();

    expect(channel.logged).toEqual([BUILDING, RELAY_READY, HANDSHAKE_SENT]);
  });

  it('writes nothing at all when the relay never starts', () => {
    // The negative twin of every line above: a page this extension never
    // injected has an empty console, which is what "not booted" looks like.
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

    startLoader(channel);
    expect(channel.logged).toEqual([HELLO_ACKED]);

    channel.post(moduleMessage());
    channel.drain();
    await vi.waitFor(() => {
      expect(channel.logged).toContain(MODULE_LOADED);
    });

    // The loader's line comes after the module's own stages: it reports the
    // stage that is complete once the module has both loaded and been started.
    expect(channel.logged.slice(0, 5)).toEqual([
      HELLO_ACKED,
      HOOK_FOUND,
      OBSERVER_INSTALLED,
      READY,
      MODULE_LOADED,
    ]);
  });

  it('writes no module line when the import fails, and says why it failed', async () => {
    const channel = createChannel();
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

    expect(channel.logged).toEqual([HELLO_ACKED]);
  });
});

describe('one boot, one console: both worlds on the same page window', () => {
  it('writes every boot stage exactly once, in the order the stages complete', async () => {
    const channel = createChannel();

    // Production order at `document_start`: the MAIN-world loader runs its body
    // synchronously, while the isolated relay's first line can only come out of
    // the async import of its module. So the loader's hello is the first line.
    startLoader(channel);
    startRelay(channel);
    await channel.settle();
    await vi.waitFor(() => {
      expect(channel.logged).toContain(MODULE_LOADED);
    });
    await channel.settle();

    expect(channel.logged).toEqual([
      HELLO_ACKED,
      BUILDING,
      RELAY_READY,
      HANDSHAKE_SENT,
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
    startLoader(channel);
    startRelay(channel);
    await channel.settle();
    await vi.waitFor(() => {
      expect(channel.logged).toContain(MODULE_LOADED);
    });
    await channel.settle();

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

    startLoader(channel);
    startRelay(channel);
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

    startLoader(channel);
    startRelay(channel);
    await channel.settle();
    await vi.waitFor(() => {
      expect(channel.logged).toContain(MODULE_LOADED);
    });
    await channel.settle();
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
