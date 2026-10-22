import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execArgv } from '../lib/exec';
import { extractJson } from './claude';
import type { AgentAdapter, AgentRunInput, AgentRunResult } from './types';

// codex never reports dollars — estimate from token usage at GPT-5-class list price
const USD_PER_INPUT_TOKEN = 1.25 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 10 / 1_000_000;

/**
 * Pull token usage out of `codex exec --json` JSONL events. The event shape is
 * version-fragile, so parse leniently: take the last `usage` object seen —
 * codex reports cumulative totals, so the last one is the run's total.
 */
export function estimateCodexCostUsd(jsonlStdout: string): number {
  let input = 0;
  let output = 0;
  for (const line of jsonlStdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = findUsage(event, 2);
    if (usage) {
      input = usage.input_tokens;
      output = usage.output_tokens;
    }
  }
  return input * USD_PER_INPUT_TOKEN + output * USD_PER_OUTPUT_TOKEN;
}

function findUsage(value: unknown, depth: number): { input_tokens: number; output_tokens: number } | undefined {
  if (typeof value !== 'object' || value === null || depth < 0) return undefined;
  const obj = value as Record<string, unknown>;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
    return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
  }
  for (const child of Object.values(obj)) {
    const found = findUsage(child, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Reviewer adapter over `codex exec` (verified against codex-cli 0.144.1:
 * --output-schema, -s read-only, --json, -o all present). Stateless by design —
 * each round's context arrives via the prompt and the ledger, not a session.
 */
export function codexAdapter(): AgentAdapter {
  return {
    name: 'codex',
    capabilities: ['review'],
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const outDir = await mkdtemp(join(tmpdir(), 'ben-codex-'));
      const outFile = join(outDir, 'last-message.txt');
      const argv = [
        'codex',
        'exec',
        '--json',
        '-C',
        input.cwd,
        '-s',
        input.readOnly ? 'read-only' : 'workspace-write',
        '-o',
        outFile,
      ];
      if (input.schemaPath) argv.push('--output-schema', input.schemaPath);
      argv.push(input.prompt);

      try {
        const r = await execArgv(argv, { cwd: input.cwd, timeoutMs: input.timeoutMs });
        let last = '';
        try {
          last = await readFile(outFile, 'utf8');
        } catch {
          // no final message written (crash or timeout kill) — raw stdout still returned below
        }
        return {
          ok: r.exitCode === 0 && !r.timedOut,
          raw: last || r.stdout || r.stderr,
          parsed: last ? extractJson(last) : undefined,
          costUsd: estimateCodexCostUsd(r.stdout),
          costIsEstimate: true,
          exitCode: r.timedOut ? 124 : r.exitCode,
        };
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
  };
}
