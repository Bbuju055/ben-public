import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import type { CriteriaDoc } from '../schemas';
import type { E2eConfig } from '../config';
import { exec } from '../lib/exec';
import { formatEvidence, writeEvidence } from './evidence';
import { runE2e } from './e2e';

export type CriterionStatus = 'pass' | 'fail' | 'manual';

export interface MatrixEntry {
  status: CriterionStatus;
  evidencePath: string;
}

export type CriteriaMatrix = Record<string, MatrixEntry>;

/** Run every criterion's verification command; write evidence + criteria-matrix.json. */
export async function runCriteria(
  doc: CriteriaDoc,
  cwd: string,
  taskDirPath: string,
  e2eCfg: E2eConfig,
  timeoutMs: number,
  suffix = '',
): Promise<CriteriaMatrix> {
  const evidDir = join(taskDirPath, 'evidence');
  const matrix: CriteriaMatrix = {};

  for (const c of doc.criteria) {
    const { method, command } = c.verification;
    if (method === 'manual') {
      const evidencePath = await writeEvidence(
        evidDir,
        `criteria-${c.id}${suffix}.txt`,
        `MANUAL criterion — requires a human check before merge.\nStatement: ${c.statement}`,
      );
      matrix[c.id] = { status: 'manual', evidencePath };
      continue;
    }
    if (!command) {
      const evidencePath = await writeEvidence(
        evidDir,
        `criteria-${c.id}${suffix}.txt`,
        `FAIL: criterion has method "${method}" but no command.`,
      );
      matrix[c.id] = { status: 'fail', evidencePath };
      continue;
    }
    if (method === 'e2e') {
      const artifactsDir = join(evidDir, 'e2e', `${c.id}${suffix}`);
      const r = await runE2e({
        command,
        cwd,
        artifactsDir,
        server: { serverCommand: e2eCfg.serverCommand, readyUrl: e2eCfg.readyUrl },
        timeoutMs,
      });
      const evidencePath = await writeEvidence(evidDir, `criteria-${c.id}${suffix}.txt`, formatEvidence(command, r));
      matrix[c.id] = { status: r.exitCode === 0 ? 'pass' : 'fail', evidencePath };
      continue;
    }
    const r = await exec(command, { cwd, timeoutMs });
    const evidencePath = await writeEvidence(evidDir, `criteria-${c.id}${suffix}.txt`, formatEvidence(command, r));
    matrix[c.id] = { status: r.exitCode === 0 && !r.timedOut ? 'pass' : 'fail', evidencePath };
  }

  await mkdir(evidDir, { recursive: true });
  await writeFile(join(evidDir, 'criteria-matrix.json'), JSON.stringify(matrix, null, 2));
  return matrix;
}

export function failingCriteria(matrix: CriteriaMatrix): string[] {
  return Object.entries(matrix)
    .filter(([, e]) => e.status === 'fail')
    .map(([id]) => id);
}
