import { describe, expect, it, vi } from 'vitest';

import {
  CHALLENGE_FIELDS,
  CHALLENGE_REQUIREMENT_CONTAINERS,
  CHALLENGE_REQUIREMENT_PROPERTIES,
  resolveChallengeRequirements,
} from '../src/ea/adapter.js';

// Issue #51: requirements are not always at the top level. The resolver looks
// through the documented locations in order and reports which one answered.
// These tests cover every documented property, the method, and one level down
// into each container.

const entries = [
  { type: 'LEAGUE_COUNT', eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 3 },
];

const nested = (path, value) => {
  const root = {};
  let current = root;
  for (const segment of path.slice(0, -1)) current = current[segment] = {};
  current[path.at(-1)] = value;
  return root;
};

const topLevelCases = [
  {
    label: 'eligibilityRequirements',
    payload: () => ({ eligibilityRequirements: entries }),
    source: 'payload.eligibilityRequirements',
  },
  { label: 'requirements', payload: () => ({ requirements: entries }), source: 'payload.requirements' },
  {
    label: 'requirementsList',
    payload: () => ({ requirementsList: entries }),
    source: 'payload.requirementsList',
  },
  { label: 'elgReq', payload: () => ({ elgReq: entries }), source: 'payload.elgReq' },
  {
    label: 'getRequirements()',
    payload: () => ({ getRequirements: () => entries }),
    source: 'payload.getRequirements()',
  },
];

const nestedCases = CHALLENGE_REQUIREMENT_CONTAINERS.flatMap((path) =>
  topLevelCases.map((entry) => ({
    label: `${path.join('.')} > ${entry.label}`,
    payload: () => nested([...path], entry.payload()),
    source: `payload.${path.join('.')}.${
      entry.source.replace('payload.', '')
    }`,
  }))
);

describe('resolveChallengeRequirements', () => {
  for (const { label, payload, source } of [...topLevelCases, ...nestedCases]) {
    it(`finds requirements through ${label} and reports that location as the source`, () => {
      const result = resolveChallengeRequirements(payload());

      expect(result.ok).toBe(true);
      expect(result.requirements).toBe(entries);
      expect(result.source).toBe(source);
      const winner = result.attempts.find((attempt) => attempt.ok);
      expect(winner.id).toBe(source);
      expect(winner.reason).toBeNull();
    });
  }

  it('uses the documented order: top level before nested, and the listed property order', () => {
    const payload = {
      elgReq: entries,
      requirements: [{ type: 'NATION_COUNT', eligibilitySlot: 2, eligibilityKey: 7, eligibilityValue: 2 }],
      challenge: { eligibilityRequirements: entries },
    };

    const result = resolveChallengeRequirements(payload);

    expect(result.source).toBe('payload.requirements');
    expect(result.attempts.map((attempt) => attempt.id)).toEqual([
      'payload.eligibilityRequirements',
      'payload.requirements',
    ]);
  });

  it('calls getRequirements with no arguments and records its method shape', () => {
    const receivedArguments = [];
    function getRequirements() {
      receivedArguments.push([...arguments]);
      return entries;
    }

    const result = resolveChallengeRequirements({ getRequirements });

    expect(receivedArguments).toEqual([[]]);
    expect(result.ok).toBe(true);
    const attempt = result.attempts.find((entry) => entry.id === 'payload.getRequirements()');
    expect(attempt.method.arity).toBe(0);
    expect(attempt.method.excerpt).toContain('getRequirements');
  });

  it('ignores a property value that is not an array and keeps looking', () => {
    const result = resolveChallengeRequirements({
      eligibilityRequirements: {},
      requirements: 'later',
      requirementsList: null,
      elgReq: [],
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('payload.elgReq');
    const failed = result.attempts.filter((attempt) => !attempt.ok);
    expect(failed.map((attempt) => attempt.id)).toEqual([
      'payload.eligibilityRequirements',
      'payload.requirements',
      'payload.requirementsList',
    ]);
    for (const attempt of failed) expect(attempt.reason.length).toBeGreaterThan(0);
  });

  it('refuses an accessor property and an accessor method without invoking them', () => {
    const eligibilityGetter = vi.fn(() => entries);
    const methodGetter = vi.fn(() => () => entries);
    const payload = {};
    Object.defineProperty(payload, 'eligibilityRequirements', { get: eligibilityGetter });
    Object.defineProperty(payload, 'getRequirements', { get: methodGetter });

    const result = resolveChallengeRequirements(payload);

    expect(eligibilityGetter).not.toHaveBeenCalled();
    expect(methodGetter).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.attempts[0].reason).toMatch(/accessor/);
    const methodAttempt = result.attempts.find((attempt) =>
      attempt.id.endsWith('.getRequirements()')
    );
    expect(methodAttempt.reason).toMatch(/accessor/);
  });

  it('records a throwing getRequirements and keeps looking', () => {
    const result = resolveChallengeRequirements({
      getRequirements() {
        throw new Error('needs a challenge argument');
      },
      challenge: { requirements: entries },
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('payload.challenge.requirements');
    const methodAttempt = result.attempts.find((attempt) => attempt.id === 'payload.getRequirements()');
    expect(methodAttempt.reason).toBe('threw: needs a challenge argument');
  });

  it('fails with a reason naming every location it looked in when none carries requirements', () => {
    const result = resolveChallengeRequirements({ name: 'no requirements here', challenge: {} });

    expect(result.ok).toBe(false);
    expect(result.requirements).toBeNull();
    expect(result.source).toBeNull();
    expect(result.attempts.length).toBe(5 * (1 + CHALLENGE_REQUIREMENT_CONTAINERS.length));
    const reasons = result.attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('\n');
    for (const field of [...CHALLENGE_REQUIREMENT_PROPERTIES, CHALLENGE_FIELDS.getRequirements]) {
      expect(reasons).toContain(field);
    }
    for (const path of CHALLENGE_REQUIREMENT_CONTAINERS) {
      expect(result.attempts.some((attempt) => attempt.id.startsWith(`payload.${path.join('.')}.`))).toBe(
        true
      );
    }
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(typeof attempt.reason).toBe('string');
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports a non-object payload through every location instead of throwing', () => {
    const result = resolveChallengeRequirements(null);

    expect(result.ok).toBe(false);
    expect(result.attempts.every((attempt) => attempt.reason.includes('not an object'))).toBe(true);
  });
});
