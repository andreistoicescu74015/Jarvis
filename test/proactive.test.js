import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startProactive } from '../src/core/proactive.js';

test('startProactive: never overlaps ticks, and stop() drains the in-flight one', async () => {
  let calls = 0;
  let done = false;
  let entered;
  let release;
  const enteredP = new Promise((r) => (entered = r));
  const releaseP = new Promise((r) => (release = r));
  const tick = async () => {
    calls++;
    entered();
    await releaseP; // hold the tick in-flight
    done = true;
  };

  const runner = startProactive(tick, { intervalMs: 5 });
  await enteredP; // the first tick is running
  await new Promise((r) => setTimeout(r, 30)); // several intervals pass while we block
  assert.equal(calls, 1); // the re-entrancy guard kept them from overlapping

  const stopP = runner.stop();
  let resolvedEarly = false;
  await Promise.race([stopP.then(() => (resolvedEarly = true)), new Promise((r) => setTimeout(r, 15))]);
  assert.equal(resolvedEarly, false); // stop() waits for the in-flight tick
  assert.equal(done, false);

  release();
  await stopP;
  assert.equal(done, true); // the tick completed before stop() resolved
});
