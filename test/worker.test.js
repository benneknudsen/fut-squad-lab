import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import { normaliseChemistryProfile, normaliseTeamChemLinks } from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { PROGRESS_STAGES } from '../src/solver/worker-protocol.js';
import { withEligibility } from './helpers/eligibility.js';
import clubFixture from './fixtures/club-items.json';
import linksFixture from './fixtures/chemistry-teamlinks.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import set16 from './fixtures/sbs-set-16-challenges.json';

// Drive the real shell through a fake `self`, the same way the extension will
// drive it through a real Worker. The shell reads `self.postMessage` lazily, so
// a single import is enough.
const posted = [];
globalThis.self = { postMessage: (message) => posted.push(message) };
await import('../src/solver/worker.js');
const worker = globalThis.self;
const send = (data) => worker.onmessage({ data });

const request = (id, operation, payload) => send({ kind: 'request', id, operation, payload });
const only = (kind) => posted.filter((message) => message.kind === kind);

const POOL = buildPool(normaliseClub(clubFixture.items));
const CHEMISTRY_RULE_SET = normaliseChemistryProfile({
  ...profilesFixture,
  mappings: [{ profileId: 4, rarityIds: [0, 69] }],
});
const OPTIONS = withEligibility({
  seed: 1,
  chemistryRuleSet: CHEMISTRY_RULE_SET,
  clubLinks: linksFixture.teamChemLinks,
  effort: 'fast',
});
const CHALLENGE = set16.challenges[3];

beforeEach(() => {
  posted.length = 0;
});

describe('worker shell', () => {
  it('solves through the real solver and answers with the result', () => {
    request(1, 'solve', { challenge: CHALLENGE, pool: POOL, options: OPTIONS });

    const response = posted.at(-1);
    expect(response.kind).toBe('response');
    expect(response.id).toBe(1);
    expect(response.result.valid).toBe(true);
    expect(response.result.squad.players).toHaveLength(11);
  });

  it('emits a start and a completion progress message with the solver real counters', () => {
    request(2, 'solve', { challenge: CHALLENGE, pool: POOL, options: OPTIONS });

    const progress = only('progress');
    expect(progress).toHaveLength(2);

    const [start, completion] = progress;
    expect(start).toEqual({
      kind: 'progress',
      id: 2,
      stage: PROGRESS_STAGES.SEARCH_LINEUPS,
      counters: {},
    });
    expect(completion.stage).toBe(PROGRESS_STAGES.SEARCH_LINEUPS);

    const { result } = posted.at(-1);
    expect(completion.counters).toEqual({
      lineups: result.improvements.lineups,
      bestCost: result.cost,
      elapsedMs: result.improvements.elapsedMs,
    });
    for (const value of Object.values(completion.counters)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('answers a reevaluate request with the alternatives payload', () => {
    request(3, 'solve', { challenge: CHALLENGE, pool: POOL, options: OPTIONS });
    const solved = posted.at(-1).result;

    posted.length = 0;
    request(4, 'reevaluate', {
      squad: solved.squad,
      lockedSlots: [0],
      pool: POOL,
      options: { ...OPTIONS, challenge: CHALLENGE },
    });

    const response = posted.at(-1);
    expect(response.kind).toBe('response');
    expect(response.id).toBe(4);
    expect(response.result.squad.players).toHaveLength(11);
    expect(response.result.alternatives).toHaveLength(11);
    expect(response.result.alternatives[0]).toEqual([]);
  });

  it('reports a mid-request solver throw as a structured error and keeps the worker alive', () => {
    request(5, 'solve', {
      challenge: { formation: 'f999', elgOperation: 'AND', elgReq: [] },
      pool: POOL,
      options: OPTIONS,
    });

    expect(only('response')).toEqual([]);
    const error = posted.at(-1);
    expect(error.kind).toBe('error');
    expect(error.id).toBe(5);
    expect(error.error.message).toMatch(/unknown formation/);

    posted.length = 0;
    request(6, 'solve', { challenge: CHALLENGE, pool: POOL, options: OPTIONS });
    expect(posted.at(-1).kind).toBe('response');
    expect(posted.at(-1).result.valid).toBe(true);
  });
});

describe('worker shell stays thin', () => {
  const source = readFileSync(new URL('../src/solver/worker.js', import.meta.url), 'utf8');
  const protocolSource = readFileSync(
    new URL('../src/solver/worker-protocol.js', import.meta.url),
    'utf8'
  );

  it('imports only the protocol module and the solver entry point', () => {
    const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['./solve.js', './worker-protocol.js']);
    for (const leaked of [
      'candidates.js',
      'prices.js',
      'chemistry.js',
      'validate.js',
      'requirements.js',
      'adapter.js',
    ]) {
      expect(source).not.toContain(`./${leaked}`);
    }
  });

  it('dispatches to solve and reevaluate and nothing else', () => {
    expect(source).toMatch(/\bsolve\(/);
    expect(source).toMatch(/\breevaluate\(/);
    for (const name of ['improve(', 'buildPool(', 'validateSquad(', 'squadChemistry(']) {
      expect(source).not.toContain(name);
    }
  });

  it('keeps the pure protocol module free of browser globals', () => {
    for (const pattern of [/\bself\./, /\bwindow\./, /\bdocument\./, /\bchrome\./, /new Worker/]) {
      expect(protocolSource).not.toMatch(pattern);
    }
  });
});
