#!/usr/bin/env node
// Stub codex for runner tests: `login status` only (the reviewer itself is stubbed via BEN_REVIEWER_CLI inside run.mjs).
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
console.error('stub codex: unsupported');
process.exit(64);
