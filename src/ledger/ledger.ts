import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { taskDir } from '../orchestrator/state';

export type LedgerKind = 'plan' | 'diff';
export type LedgerAction =
  | 'raised'
  | 'resolved'
  | 'rejected'
  | 'deferred'
  | 'auto-dropped'
  | 're-raise-dropped'
  | 'abstain';

export interface LedgerEntry {
  ts: string;
  kind: LedgerKind;
  round: number;
  reviewer: string;
  /** reviewer-local blocker id; '' for abstain entries */
  blockerId: string;
  /** stable fingerprint (see fingerprintBlocker); '' for abstain entries */
  fingerprint: string;
  action: LedgerAction;
  detail: string;
}

export function ledgerPath(taskId: string): string {
  return join(taskDir(taskId), 'ledger.jsonl');
}

/** Append-only — this file is never rewritten. */
export async function appendLedger(taskId: string, entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(taskDir(taskId), { recursive: true });
  await appendFile(ledgerPath(taskId), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** Parse ledger entries from raw jsonl — lets a caller hash and render one identical read. */
export function parseLedger(raw: string): LedgerEntry[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export async function readLedger(taskId: string): Promise<LedgerEntry[]> {
  const path = ledgerPath(taskId);
  if (!existsSync(path)) return [];
  return parseLedger(await readFile(path, 'utf8'));
}

const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|html|py|rs|go|sql|toml|yaml|yml|sh)$/i;

/**
 * Stable blocker identity, so a rejected blocker cannot return by paraphrase:
 * sha256 (first 12 hex) of criterionRef + the sorted path-like tokens in the evidence.
 * Line numbers never make it in — `file.ts:14` tokenizes to `file.ts` — so the identity
 * survives line drift between rounds. Evidence naming no file falls back to the
 * normalized claim text. Deterministic on purpose; no model in the loop.
 */
export function fingerprintBlocker(b: { criterionRef?: string; evidence?: string; claim: string }): string {
  const tokens = (b.evidence ?? '').match(/[\w.@/-]+/g) ?? [];
  const paths = [...new Set(tokens.filter((t) => t.includes('/') || CODE_EXT_RE.test(t)))].sort();
  const basis =
    paths.length > 0
      ? `${b.criterionRef ?? ''}|${paths.join('|')}`
      : `${b.criterionRef ?? ''}|${(b.claim.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

export function rejectedFingerprints(entries: LedgerEntry[], kind: LedgerKind): Set<string> {
  return new Set(entries.filter((e) => e.kind === kind && e.action === 'rejected').map((e) => e.fingerprint));
}

/** Deterministic prompt rendering: chronological, one line per entry. */
export function renderLedger(entries: LedgerEntry[]): string {
  if (entries.length === 0) return '(empty)';
  return entries
    .map(
      (e) =>
        `[${e.kind} round ${e.round}] ${e.action} ${e.fingerprint || '-'} (${e.reviewer}${e.blockerId ? `/${e.blockerId}` : ''}): ${e.detail}`,
    )
    .join('\n');
}
