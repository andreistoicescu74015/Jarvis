import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/core/registry.js';
import { createDispatcher } from '../src/core/dispatch.js';
import shutdown from '../src/commands/shutdown.js';
import restart from '../src/commands/restart.js';
import logout from '../src/commands/logout.js';

const commands = [
  [shutdown, 'shutdown'],
  [restart, 'restart'],
  [logout, 'logout'],
];

for (const [cmd, key] of commands) {
  test(`${key}: is owner-scoped and triggers ctx.lifecycle.${key}`, () => {
    assert.deepEqual(cmd.scope, { owner: true });
    let called = 0;
    const reply = cmd.run({ lifecycle: { [key]: () => { called += 1; } } });
    assert.equal(called, 1);
    assert.ok(typeof reply === 'string' && reply.length > 0);
  });

  test(`${key}: replies gracefully when the capability is absent`, () => {
    assert.match(cmd.run({}), /not (available|supported)/i);
  });
}

test('lifecycle: the dispatcher injects ctx.lifecycle and owner-gates the command', async () => {
  let called = 0;
  const handle = createDispatcher(createRegistry([shutdown]), {
    owner: 'boss',
    lifecycle: { shutdown: () => { called += 1; } },
  });
  const ownerReply = await handle({ text: 'jarvis shutdown', sender: 'boss' });
  assert.equal(called, 1);
  assert.match(ownerReply, /shut/i);

  const denied = await handle({ text: 'jarvis shutdown', sender: 'rando' });
  assert.equal(called, 1); // not invoked for a non-owner
  assert.match(denied, /Not allowed: owner only/);
});
