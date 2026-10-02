/**
 * The fixed session nonce the message-channel tests run against.
 *
 * `startContentApp` mints a real nonce from `crypto.getRandomValues`, so a test
 * that wanted to assert on a message would otherwise have to read the nonce back
 * out of the channel first and could still race a second session. Injecting a
 * `crypto` that fills the array with 0, 1, 2 … 15 makes every test assert one
 * known value instead of a generated one.
 *
 * The value is deliberately the ascending byte sequence and not a random-looking
 * string: no genuine 16-byte nonce can produce it, so a test can never
 * accidentally collide with, or be mistaken for, a real one.
 */

import { formatNonce } from '../../src/ui/messages.js';

const ascendingBytes = (length) => Uint8Array.from({ length }, (_value, index) => index);

export const TEST_NONCE = formatNonce(ascendingBytes(16));

/** A `crypto` stub whose `getRandomValues` fills the array with 0, 1, 2 … */
export const stubCrypto = () => ({
  getRandomValues: (array) => ascendingBytes(array.length),
});
