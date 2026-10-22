import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ExecResult } from '../lib/exec';

const MAX_PROMPT_BYTES = 16_384;
const HEAD_LINES = 200;
const TAIL_LINES = 200;

export async function writeEvidence(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

export function formatEvidence(command: string, r: ExecResult): string {
  return [
    `$ ${command}`,
    `exit: ${r.exitCode}${r.timedOut ? ' (TIMED OUT, killed)' : ''}  duration: ${r.durationMs}ms`,
    '--- stdout ---',
    r.stdout,
    '--- stderr ---',
    r.stderr,
  ].join('\n');
}

/**
 * Mechanical truncation for prompts: full file stays on disk untouched.
 * Head + tail with an explicit marker — never a model summary.
 */
export function truncateForPrompt(content: string, fullPath: string): string {
  if (Buffer.byteLength(content, 'utf8') <= MAX_PROMPT_BYTES) return content;
  const lines = content.split('\n');
  const omitted = Math.max(0, lines.length - HEAD_LINES - TAIL_LINES);
  const head = lines.slice(0, HEAD_LINES).join('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  const marker = `\n[... ${omitted} lines omitted — full file at ${fullPath} ...]\n`;
  const out = head + marker + tail;
  if (Buffer.byteLength(out, 'utf8') <= MAX_PROMPT_BYTES) return out;
  // pathological single-line output: hard byte slice around the marker
  const budget = Math.floor((MAX_PROMPT_BYTES - marker.length) / 2);
  return content.slice(0, budget) + marker + content.slice(-budget);
}
