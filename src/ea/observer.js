/**
 * A read-only method observer for EA's own calls (#64).
 *
 * The club read kept failing inside EA while we could not say how EA itself
 * calls the same methods, and every inference from our side was exhausted. This
 * module answers that by recording **how a method was called**: it wraps a
 * method, records the call, calls through unchanged and returns EA's result
 * untouched. Nothing here inspects or changes the arguments, and nothing awaits
 * or subscribes to a returned value.
 *
 * Fidelity is the whole point, so the wrapper:
 *
 * - calls the original with the **same `this`** and the **same arguments**;
 * - returns the original's value by identity, including a function, an
 *   observable and a rejected promise, without touching it;
 * - records before the call, so a throwing method still leaves its attempt;
 * - rethrows the original error object, never a copy.
 *
 * Recording is content-free by construction. The only values that may ever
 * appear are the fields named in `valueFields`, which the caller supplies from
 * the allowlist in `src/ea/adapter.js`; every other field contributes its name
 * and type only, read through `src/shape.js`, which never invokes an accessor.
 * A name that matches the shared paste-safety list is reported as
 * `<redacted>`, so a hidden field stays distinguishable from an absent one.
 *
 * Who made a call is decided from the **innermost** stack frame that is not
 * this module's own machinery: the wrapper and `capture` are skipped, because
 * our frames are not evidence about the caller. A call EA's code nests beneath
 * our own invocation is therefore attributed to EA, while our direct calls
 * still read as ours. Every record also carries `nested`, true when the call
 * happened during another observed call, so a nested EA call is stated by the
 * log rather than inferred from a stack. The nesting depth is released in a
 * `finally`, so a throw cannot leave the flag set.
 *
 * Observers are removable: `remove()` restores every wrapped method to exactly
 * the function it replaced and drops the wrappers, so nothing is left
 * installed. Recording is bounded by `callCap`, with the dropped count carried
 * in the report, so a hot loop cannot grow the diagnostic without limit.
 *
 * This module is pure of the page: no DOM, no `chrome.*`, no EA names, no
 * network. It takes the holders it wraps as plain data.
 */

import { describeOwnPropertyTypes } from '../shape.js';

/** The default number of calls one observer records before it starts dropping. */
export const DEFAULT_OBSERVER_CALL_CAP = 50;

/** The most own keys one formatted argument line prints before it elides. */
const MAX_RENDERED_KEYS = 8;

/** Marks a wrapper this module installed, so install is idempotent. */
const WRAPPED_BY_OBSERVER = Symbol('fslObservedMethod');

/**
 * Classifies the frame that made a call as our code or EA's, using the stack
 * only: every frame belonging to this module is dropped — the wrapper and
 * `capture` included, since they are not evidence about the caller — and the
 * **innermost** remaining frame decides. A call EA's code nests beneath our own
 * invocation is therefore attributed to EA, because EA's frame is the one that
 * issued it, while our direct calls still read as ours. A frame that proves
 * neither yields `unknown`, never `extension`. The stack itself is never
 * recorded, so no page URL or EA source location can reach a pasted report.
 */
const defaultClassifyOrigin = (stack) => {
  if (typeof stack !== 'string' || stack.length === 0) return 'unknown';
  const caller = stack
    .split('\n')
    .slice(1)
    .find((line) => !line.includes('observer.js'));
  if (caller === undefined) return 'unknown';
  if (caller.includes('chrome-extension://')) return 'extension';
  if (/https?:\/\//.test(caller)) return 'ea';
  return 'unknown';
};

const readStack = () => {
  try {
    return new Error().stack;
  } catch {
    return '';
  }
};

/**
 * Reads a method as a data property along the prototype chain, never invoking
 * an accessor. Returns the function, a named reason for an accessor, or `null`
 * when the property is absent or not a function.
 */
const readMethod = (holder, method) => {
  let current = holder;
  while (current !== null && current !== undefined) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, method);
    } catch {
      return { value: null, reason: 'unreadable' };
    }
    if (descriptor !== undefined) {
      if (typeof descriptor.get === 'function') return { value: null, reason: 'accessor(get)' };
      return typeof descriptor.value === 'function'
        ? { value: descriptor.value, reason: null }
        : { value: null, reason: null };
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return { value: null, reason: 'unreadable' };
    }
  }
  return { value: null, reason: null };
};

const isPrimitiveValue = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/**
 * Reads the allowlisted fields off an argument as own data properties only.
 * An accessor is never invoked, and a value that is not a primitive is not
 * carried: the allowlist permits a value, never a structure.
 */
const allowedValues = (value, valueFields) => {
  const values = {};
  let found = false;
  for (const field of valueFields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      continue;
    }
    if (descriptor === undefined || descriptor.get !== undefined) continue;
    if (!isPrimitiveValue(descriptor.value)) continue;
    values[field] = descriptor.value;
    found = true;
  }
  return found ? values : null;
};

const describeArgument = (value, valueFields) => {
  try {
    if (value === null) return { type: 'null' };
    if (value === undefined) return { type: 'undefined' };
    if (typeof value === 'string') return { type: 'string', empty: value.length === 0 };
    if (typeof value === 'function') return { type: 'function' };
    if (typeof value !== 'object') return { type: typeof value };
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    const described = { type: 'object', keys: describeOwnPropertyTypes(value) };
    const values = allowedValues(value, valueFields);
    if (values !== null) described.values = values;
    return described;
  } catch {
    return { type: 'unreadable' };
  }
};

const renderKey = (entry) =>
  entry.type === 'string'
    ? `${entry.name}:string(${entry.empty ? 'empty' : 'non-empty'})`
    : `${entry.name}:${entry.type}`;

const renderPrimitive = (value) =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

const renderValues = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name}:${renderPrimitive(value)}`)
    .join(',');

const renderArgument = (argument) => {
  if (argument.type === 'object') {
    const shown = argument.keys.slice(0, MAX_RENDERED_KEYS).map(renderKey);
    const rest = argument.keys.length - shown.length;
    const elided = rest > 0 ? `,…+${rest}` : '';
    const values = argument.values === undefined ? '' : ` values{${renderValues(argument.values)}}`;
    return `object{${shown.join(',')}${elided}}${values}`;
  }
  if (argument.type === 'array') return `array[${argument.length}]`;
  if (argument.type === 'string') return argument.empty ? 'string(empty)' : 'string(non-empty)';
  return argument.type;
};

/**
 * One console line for one recorded call: the method, the argument count, who
 * made the call, whether it happened during another observed call, whether
 * `this` was the wrapped target, and the shape of every argument. Values appear
 * only where the allowlist permits them.
 *
 * @param {object} call one entry from the observer report's `calls`
 * @returns {string} one line, never a newline
 */
export function formatObserverCall(call) {
  const argumentsPart = call.args.map((argument, index) => `arg${index}=${renderArgument(argument)}`);
  return (
    `${call.method} args=${call.argumentCount} origin=${call.origin}` +
    ` nested=${call.nested === true ? 'true' : 'false'}` +
    ` this=${call.thisMatchesTarget ? 'target' : call.thisType}` +
    `${call.threw ? ' threw' : ''}` +
    (argumentsPart.length === 0 ? '' : ` ${argumentsPart.join(' ')}`)
  );
}

/**
 * Creates one observer. `install` wraps the supplied targets, `remove` restores
 * them all, and `report` returns what was captured:
 *
 *   {
 *     calls: [{ method, argumentCount, origin, nested, thisType,
 *               thisMatchesTarget, threw, args: [{ type, keys?, values?,
 *               length?, empty? }] }],
 *     dropped: number,
 *     truncated: boolean,
 *     methods: [{ id, installed, reason }],
 *   }
 *
 * `valueFields` is the only source of recorded values; `classifyOrigin` is
 * injectable for tests; `onCall` receives every recorded call and may throw
 * without affecting the observed method.
 *
 * @param {{ callCap?: number, valueFields?: Array<string>,
 *   classifyOrigin?: (stack: string) => string, onCall?: Function }} [options]
 * @returns {{ install: Function, remove: Function, report: Function }}
 */
export function createMethodObserver(options = {}) {
  const callCap =
    Number.isInteger(options.callCap) && options.callCap >= 0
      ? options.callCap
      : DEFAULT_OBSERVER_CALL_CAP;
  const valueFields = Array.isArray(options.valueFields)
    ? options.valueFields.filter((field) => typeof field === 'string')
    : [];
  const classifyOrigin =
    typeof options.classifyOrigin === 'function' ? options.classifyOrigin : defaultClassifyOrigin;
  const onCall = typeof options.onCall === 'function' ? options.onCall : null;

  let calls = [];
  let dropped = 0;
  let methods = [];
  let installed = [];
  // How many observed calls are currently in progress. Zero means the next call
  // is top-level; anything above means it happened during another observed call
  // and is recorded as nested. Released in the wrapper's `finally`.
  let depth = 0;

  const capture = (id, holder, thisValue, args, nested) => {
    if (calls.length >= callCap) {
      dropped += 1;
      return null;
    }
    const record = {
      method: id,
      argumentCount: args.length,
      origin: classifyOrigin(readStack()),
      nested,
      thisType:
        thisValue === null ? 'null' : thisValue === undefined ? 'undefined' : typeof thisValue,
      thisMatchesTarget: thisValue === holder,
      args: args.map((argument) => describeArgument(argument, valueFields)),
      threw: false,
    };
    calls.push(record);
    if (onCall !== null) {
      try {
        onCall(record);
      } catch {
        // A consumer of the record must never break the observed call.
      }
    }
    return record;
  };

  const installOne = (target) => {
    const outcome = { id: target.id, installed: false, reason: null };
    const { holder, method } = target;
    if (holder === null || holder === undefined) {
      outcome.reason =
        typeof target.reason === 'string' && target.reason.length > 0
          ? target.reason
          : `${target.id} has no holder in this page`;
      methods.push(outcome);
      return outcome;
    }
    const read = readMethod(holder, method);
    if (read.value === null) {
      outcome.reason = read.reason ?? `target has no ${method} method`;
      methods.push(outcome);
      return outcome;
    }
    if (read.value[WRAPPED_BY_OBSERVER] === true) {
      outcome.installed = true;
      methods.push(outcome);
      return outcome;
    }

    const original = read.value;
    const wrapped = function (...args) {
      const nested = depth > 0;
      depth += 1;
      let record = null;
      try {
        record = capture(target.id, holder, this, args, nested);
      } catch {
        record = null;
      }
      try {
        return original.apply(this, args);
      } catch (error) {
        if (record !== null) record.threw = true;
        throw error;
      } finally {
        depth -= 1;
      }
    };
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true });
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true });
    wrapped[WRAPPED_BY_OBSERVER] = true;

    const ownedBefore = Object.hasOwn(holder, method);
    try {
      holder[method] = wrapped;
    } catch (error) {
      outcome.reason = `could not wrap: ${error.message}`;
      methods.push(outcome);
      return outcome;
    }
    installed.push({ holder, method, original, wrapped, ownedBefore });
    outcome.installed = true;
    methods.push(outcome);
    return outcome;
  };

  return {
    /**
     * Wraps every supplied target. A target is `{ id, holder, method }`; a
     * missing holder, an absent method and an accessor are recorded as a
     * not-installed outcome with a reason, never thrown. Installing the same
     * target again is a no-op.
     */
    install(targets) {
      if (!Array.isArray(targets)) throw new Error('observer.install: targets must be an array');
      return targets.map(installOne);
    },

    /**
     * Restores every wrapped method to exactly the function it replaced, and
     * removes the own wrapper a prototype method gained. Idempotent.
     */
    remove() {
      for (const entry of installed) {
        const current = entry.holder[entry.method];
        if (current !== entry.wrapped) continue;
        if (entry.ownedBefore) entry.holder[entry.method] = entry.original;
        else delete entry.holder[entry.method];
      }
      installed = [];
    },

    /** A plain copy of what has been captured, safe to serialise. */
    report() {
      return {
        calls: calls.map((call) => ({ ...call, args: call.args.map((argument) => ({ ...argument })) })),
        dropped,
        truncated: dropped > 0,
        methods: methods.map((entry) => ({ ...entry })),
      };
    },
  };
}