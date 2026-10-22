#!/usr/bin/env node
// Explicit CI partitions. New test files default to core; no silent platform skips.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [group, option] = process.argv.slice(2);
if (!['core', 'browser', 'sandbox'].includes(group) || (option !== undefined && option !== '--list') || process.argv.length > 4) {
  console.error('Usage: node scripts/test.mjs core|browser|sandbox [--list]');
  process.exit(2);
}
const special = { 'e2e.test.ts': 'browser', 'runner.test.ts': 'sandbox', 'verify-sandbox.test.ts': 'sandbox' };
const files = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.ts') && (special[name] ?? 'core') === group).sort();
if (option === '--list') {
  console.log(files.join('\n'));
  process.exit(0);
}
if (group === 'sandbox' && process.platform !== 'darwin') {
  console.error('Sandbox/runner checks require macOS /usr/bin/sandbox-exec; this group was not tested.');
  process.exit(2);
}
// These integration cases launch multiple Git/Node processes. Bun's 5s default
// can expire during valid work; explicit longer crash-drill limits still apply.
const result = spawnSync('bun', ['test', '--timeout', '30000', ...files.map(name => join(root, 'tests', name))], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
