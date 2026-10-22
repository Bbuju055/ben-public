import { exec } from '../lib/exec';
import { formatEvidence, writeEvidence } from './evidence';

export interface GateResult {
  name: string;
  exitCode: number;
  evidencePath: string;
  durationMs: number;
}

/** Run every configured gate command in the worktree, capturing raw output as evidence. */
export async function runGates(
  gates: Record<string, string>,
  cwd: string,
  evidDir: string,
  timeoutMs: number,
  suffix = '',
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const [name, command] of Object.entries(gates)) {
    const r = await exec(command, { cwd, timeoutMs });
    // suffix carries the round (e.g. "-r2") so a retry never overwrites the evidence of the failure
    const evidencePath = await writeEvidence(evidDir, `gate-${name}${suffix}.txt`, formatEvidence(command, r));
    results.push({
      name,
      exitCode: r.timedOut ? 124 : r.exitCode,
      evidencePath,
      durationMs: r.durationMs,
    });
  }
  return results;
}
