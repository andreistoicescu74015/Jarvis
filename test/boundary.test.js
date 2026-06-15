import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');

// Architecture guard: commands are leaves. A command must never import another
// command (or any sibling in commands/). Shared behavior belongs in the core,
// reached via ctx - so commands stay independent, testable, and removable.
test('no command imports a sibling command', async () => {
  const files = (await readdir(commandsDir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected at least one command');
  for (const file of files) {
    const src = await readFile(join(commandsDir, file), 'utf8');
    const importsSibling = /\bfrom\s+['"](\.\/|\.\.\/commands\/)/.test(src);
    assert.ok(!importsSibling, `${file} must not import a sibling command`);
  }
});
