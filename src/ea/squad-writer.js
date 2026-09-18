/**
 * Builds the challenge-squad payload for a solved squad and writes it through
 * EA's own objects.
 *
 * `applySolution` is pure: it turns the challenge squad template plus a solved
 * squad into the payload shape captured in
 * `test/fixtures/sbs-challenge-25-squad.json` —
 *
 *   { challengeId, squad: { id, formation, rating, chemistry, manager, players } }
 *
 * where every `players` entry keeps its formation slot `index` and carries the
 * *real* club `itemData` record for the player chosen for that slot. No item is
 * ever synthesised: a solution player whose id is not in `clubIndex` is left
 * unplaced and reported, never invented.
 *
 * ## Respecting existing squad state
 *
 * A formation slot that already holds a player is preserved, never overwritten;
 * only a slot carrying the captured empty-template marker
 * (`EMPTY_SLOT_ITEM_ID`) is filled. `planSquadWrite` returns which slots were
 * placed, preserved and left unplaced, so the choice is visible in the report.
 * A concept player has no club record, so it is always unplaced and its slot
 * keeps whatever the challenge squad already had; the payload stays a valid
 * shape rather than a fabricated card the user does not own.
 *
 * ## Writing
 *
 * `writeSolution` feature-detects EA's own write paths in the documented order
 * (`SQUAD_WRITE_STRATEGIES` in `src/ea/adapter.js`) and reports which one
 * answered, with an attempt record and reason per candidate. It never forges an
 * HTTP request and never calls `submitChallenge`: filling the squad is the end
 * of this milestone, submitting stays the owner's manual click.
 *
 * This module is pure except for `writeSolution`, which only touches the
 * caller-supplied page window — never a module-level browser global.
 */

import {
  CHALLENGE_SQUAD_FIELDS,
  EMPTY_SLOT_ITEM_ID,
  SQUAD_WRITE_STRATEGIES,
  resolveStrategyBase,
} from './adapter.js';

const F = CHALLENGE_SQUAD_FIELDS;

const fail = (message) => {
  throw new Error(`squad-writer: ${message}`);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const describeValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return `an object (${Object.keys(value).join(', ') || 'no keys'})`;
  return typeof value;
};

const messageOf = (error) =>
  error !== null && typeof error === 'object' ? error.message : String(error);

/**
 * Reads a raw club item by its stable record id. A `Map` (the shape the page
 * bridge builds) and a plain object keyed by id are both accepted; anything
 * else is a caller bug and throws rather than silently placing nothing.
 */
const lookupClubItem = (clubIndex, id) => {
  if (clubIndex instanceof Map) return clubIndex.get(id);
  if (isRecord(clubIndex)) return clubIndex[id];
  fail('clubIndex must be a Map or an object keyed by the club item id');
};

/**
 * True only for the captured empty-slot marker. Any other entry — including one
 * with no recognisable `itemData` — counts as occupied and is preserved,
 * because overwriting a player is not recoverable.
 */
const isEmptySlot = (entry) =>
  isRecord(entry) &&
  isRecord(entry[F.itemData]) &&
  entry[F.itemData][F.id] === EMPTY_SLOT_ITEM_ID;

const indexBasePlayers = (basePlayers) => {
  const positionOfIndex = new Map();
  basePlayers.forEach((entry, position) => {
    if (!isRecord(entry) || !Number.isInteger(entry[F.index])) {
      fail(
        `challenge squad players[${position}] must be an object carrying an integer` +
          ` ${F.index}; the challenge squad shape may have changed`
      );
    }
    if (positionOfIndex.has(entry[F.index])) {
      fail(`challenge squad carries two players with formation index ${entry[F.index]}`);
    }
    positionOfIndex.set(entry[F.index], position);
  });
  return positionOfIndex;
};

const requireFormationXI = (players) => {
  if (!Array.isArray(players)) {
    fail(`solution must carry squad.${F.players} as an array`);
  }
  if (players.length !== 11) {
    fail(
      `solution must carry exactly 11 players in formation slot order, found` +
        ` ${players.length}; a compacted partial squad has no stable slot indexes and must not` +
        ' be written'
    );
  }
};

/**
 * Plans the payload write for one challenge squad. The returned `players` array
 * keeps the challenge squad's own order; each entry is replaced in place, keyed
 * by its `index` field — never by its position — so an entry's formation slot
 * decides which solution player it receives.
 *
 * @param {object} challengeSquad the live challenge squad payload
 *   (`{ challengeId, squad: { ..., players } }`)
 * @param {object} solution output of `solve`/`reevaluate`; its
 *   `squad.players` must be eleven records in formation slot order
 * @param {Map|object} clubIndex raw club items keyed by the stable record `id`
 * @returns {{ payload: object, placed: Array<number>, preserved: Array<number>,
 *   unplaced: Array<{index: number, id: *, concept: boolean, reason: string}> }}
 * @throws {Error} when a required field is missing or malformed, so a changed
 *   payload shape fails loudly instead of writing a wrong squad
 */
export function planSquadWrite(challengeSquad, solution, clubIndex) {
  if (!isRecord(challengeSquad)) {
    fail('challengeSquad must be the challenge squad payload object');
  }
  if (!Number.isFinite(challengeSquad[F.challengeId])) {
    fail(`challengeSquad must carry a finite ${F.challengeId}; refusing to write without it`);
  }
  const squad = challengeSquad[F.squad];
  if (!isRecord(squad)) {
    fail(`challengeSquad must carry ${F.squad} as an object; the payload shape may have changed`);
  }
  const basePlayers = squad[F.players];
  if (!Array.isArray(basePlayers)) {
    fail(`challengeSquad.squad must carry ${F.players} as an array`);
  }
  if (!isRecord(solution) || !isRecord(solution[F.squad])) {
    fail(`solution must carry ${F.squad} as an object`);
  }
  const solutionPlayers = solution[F.squad][F.players];
  requireFormationXI(solutionPlayers);
  if (clubIndex === null || clubIndex === undefined) {
    fail('clubIndex is required to place real club item records');
  }

  const positionOfIndex = indexBasePlayers(basePlayers);
  const players = [...basePlayers];
  const placed = [];
  const preserved = [];
  const unplaced = [];

  solutionPlayers.forEach((player, slot) => {
    if (!isRecord(player) || !Number.isFinite(player[F.id])) {
      unplaced.push({
        index: slot,
        id: player?.[F.id],
        concept: false,
        reason: 'solution player carries no finite id',
      });
      return;
    }
    const position = positionOfIndex.get(slot);
    if (position === undefined) {
      unplaced.push({
        index: slot,
        id: player[F.id],
        concept: player.concept === true,
        reason: 'challenge squad has no slot at this formation index',
      });
      return;
    }
    if (!isEmptySlot(players[position])) {
      preserved.push(slot);
      return;
    }
    const rawItem = lookupClubItem(clubIndex, player[F.id]);
    if (rawItem === undefined) {
      unplaced.push({
        index: slot,
        id: player[F.id],
        concept: player.concept === true,
        reason: 'no club item record for this player; refusing to synthesise one',
      });
      return;
    }
    players[position] = { ...players[position], [F.itemData]: rawItem };
    placed.push(slot);
  });

  return {
    payload: {
      [F.challengeId]: challengeSquad[F.challengeId],
      [F.squad]: { ...squad, [F.players]: players },
    },
    placed,
    preserved,
    unplaced,
  };
}

/**
 * @param {object} challengeSquad the live challenge squad payload
 * @param {object} solution output of `solve`/`reevaluate`
 * @param {Map|object} clubIndex raw club items keyed by the stable record `id`
 * @returns {object} the squad payload to write
 * @throws {Error} same as `planSquadWrite`
 */
export function applySolution(challengeSquad, solution, clubIndex) {
  return planSquadWrite(challengeSquad, solution, clubIndex).payload;
}

const findSlot = (slots, index) => {
  const byIndex = slots.find((slot) => isRecord(slot) && slot[F.index] === index);
  if (byIndex !== undefined) return byIndex;
  const byPosition = slots[index];
  return isRecord(byPosition) ? byPosition : null;
};

/**
 * Tries the named slot mutators on every target slot, in order. A candidate
 * only answers when every slot the payload names exists and carries that
 * method; the first candidate that applies to all of them wins. Each failed
 * candidate contributes its reason to the final report.
 */
const mutateSlots = async (entity, entries, slotMethods) => {
  const getSlots = entity.getSlots;
  if (typeof getSlots !== 'function') return { ok: false, reason: 'the entity has no getSlots method' };

  let slots;
  try {
    slots = await getSlots.call(entity);
  } catch (error) {
    return { ok: false, reason: `getSlots threw: ${messageOf(error)}` };
  }
  if (!Array.isArray(slots)) {
    return { ok: false, reason: `getSlots returned ${describeValue(slots)}, not a slot array` };
  }

  const targets = [];
  const reasons = [];
  for (const entry of entries) {
    const slot = findSlot(slots, entry[F.index]);
    if (slot === null) {
      reasons.push(`no slot for formation index ${entry[F.index]}`);
      continue;
    }
    targets.push({ slot, itemData: entry[F.itemData] });
  }
  if (reasons.length > 0) {
    return { ok: false, reason: `slot lookup failed: ${reasons.join('; ')}` };
  }

  for (const method of slotMethods) {
    const missing = targets.find(({ slot }) => typeof slot[method] !== 'function');
    if (missing !== undefined) {
      reasons.push(`${method}: the slot exposes no ${method} method`);
      continue;
    }
    try {
      for (const { slot, itemData } of targets) {
        await slot[method].call(slot, itemData);
      }
    } catch (error) {
      reasons.push(`${method} threw: ${messageOf(error)}`);
      continue;
    }
    return { ok: true, slotMethod: method };
  }
  return { ok: false, reason: `no slot mutator answered (${reasons.join('; ')})` };
};

const attemptRecord = (strategy) => ({ id: strategy.id, ok: false, reason: null });

const runPlainStrategy = async (pageWindow, strategy, payload) => {
  const base = resolveStrategyBase(pageWindow, strategy);
  if (!base.ok) return { ok: false, reason: base.reason };
  const method = base.value[strategy.method];
  if (typeof method !== 'function') {
    return { ok: false, reason: `${base.name} has no ${strategy.method} method` };
  }
  if (strategy.requireArgument === true && method.length === 0) {
    return {
      ok: false,
      reason:
        `${base.name}.${strategy.method} declares no arguments, so this payload cannot be` +
        ' applied through it; trying the slot-level fallback',
    };
  }
  try {
    await method.call(base.value, payload);
  } catch (error) {
    return { ok: false, reason: `threw: ${messageOf(error)}` };
  }
  return { ok: true };
};

const runSlotStrategy = async (pageWindow, strategy, payload) => {
  const base = resolveStrategyBase(pageWindow, strategy);
  if (!base.ok) return { ok: false, reason: base.reason };
  const entries = payload?.[F.squad]?.[F.players];
  if (!Array.isArray(entries)) {
    return { ok: false, reason: `payload carries no squad.${F.players} array` };
  }
  const baseResult = await mutateSlots(base.value, entries, strategy.slotMethods);
  if (!baseResult.ok) return baseResult;

  const save = base.value[strategy.method];
  if (typeof save !== 'function') {
    return { ok: false, reason: `${base.name} has no ${strategy.method} method` };
  }
  try {
    await save.call(base.value, payload);
  } catch (error) {
    return { ok: false, reason: `save threw: ${messageOf(error)}` };
  }
  return { ok: true, slotStrategy: baseResult.slotMethod };
};

/**
 * Writes a prepared squad payload through EA's own objects, trying
 * `SQUAD_WRITE_STRATEGIES` in order.
 *
 * A candidate "answers" when its named method exists on the resolved instance
 * and the call neither throws nor rejects; the returned `attempts` array holds
 * one `{ id, ok, reason }` record per candidate tried, so a support report can
 * tell a missing method from a rejected payload. It never forges an HTTP
 * request and never calls `submitChallenge`.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {object} payload the squad payload to write
 * @returns {Promise<{ ok: boolean, strategy: string|null, attempts: Array<object>,
 *   slotStrategy?: string }>}
 */
export async function writeSolution(pageWindow, payload) {
  const attempts = [];
  for (const strategy of SQUAD_WRITE_STRATEGIES) {
    const attempt = attemptRecord(strategy);
    attempts.push(attempt);
    const outcome =
      strategy.slotMethods === undefined
        ? await runPlainStrategy(pageWindow, strategy, payload)
        : await runSlotStrategy(pageWindow, strategy, payload);
    if (!outcome.ok) {
      attempt.reason = outcome.reason;
      continue;
    }
    attempt.ok = true;
    const report = { ok: true, strategy: strategy.id, attempts };
    if (outcome.slotStrategy !== undefined) report.slotStrategy = outcome.slotStrategy;
    return report;
  }
  return { ok: false, strategy: null, attempts };
}