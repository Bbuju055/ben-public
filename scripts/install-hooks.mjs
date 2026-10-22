#!/usr/bin/env node
// install-hooks — register (or remove) the ben Stop hook in Claude settings.
// Adapted from unlazy; see ../THIRD_PARTY_NOTICES.md.
// Never run silently — offer it to the user first.
//
//   node install-hooks.mjs               install into <cwd>/.claude/settings.local.json
//   node install-hooks.mjs --shared      install into <cwd>/.claude/settings.json (tracked)
//   node install-hooks.mjs --global      install into ~/.claude/settings.json
//   node install-hooks.mjs --uninstall   remove from the chosen target (same flags)
//
// Idempotent: running install twice changes nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const global_ = args.includes('--global');
const shared = args.includes('--shared');

const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'stop-hook.mjs');
const MARKER = 'ben'; // our entries: command mentions this dir's stop-hook.mjs

const target = global_
  ? join(homedir(), '.claude', 'settings.json')
  : join(process.cwd(), '.claude', shared ? 'settings.json' : 'settings.local.json');

let settings = {};
if (existsSync(target)) {
  try {
    settings = JSON.parse(readFileSync(target, 'utf8'));
  } catch (e) {
    console.error(`Refusing to touch ${target}: it exists but is not valid JSON (${e.message}).`);
    process.exit(1);
  }
}

settings.hooks = settings.hooks || {};
const stopHooks = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];

const isOurs = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(hookScript));

const kept = stopHooks.filter((e) => !isOurs(e));

if (uninstall) {
  if (kept.length === stopHooks.length) {
    console.log(`Nothing to remove: no ${MARKER} Stop hook found in ${target}`);
    process.exit(0);
  }
  settings.hooks.Stop = kept;
  if (!settings.hooks.Stop.length) delete settings.hooks.Stop;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`Removed ${MARKER} Stop hook from ${target}`);
  process.exit(0);
}

if (stopHooks.some(isOurs)) {
  console.log(`Already installed in ${target} (idempotent, nothing changed).`);
  process.exit(0);
}

settings.hooks.Stop = [...kept, { hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 20 }] }];
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);

console.log(`Installed ${MARKER} Stop hook into ${target}
  command: node "${hookScript}"
  effect:  while .ben/ in the working directory has open blockers, failing criteria,
           or an approved build with no verification, ending the turn is blocked
           (max 6 blocks without progress; .ben/ABANDON.md is the honest exit).
  remove:  node "${fileURLToPath(import.meta.url)}"${global_ ? ' --global' : shared ? ' --shared' : ''} --uninstall`);
