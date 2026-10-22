#!/usr/bin/env node
// Deliberately scripted: exercises the real reviewer adapter without a model call.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const index = args.indexOf('-o');
if (index < 0 || !args[index + 1]) throw new Error('Expected the reviewer output path');
writeFileSync(args[index + 1], JSON.stringify({
  verdict: 'GO', blockers: [], notes: 'Synthetic GO from the offline example; no model review occurred.',
}));
