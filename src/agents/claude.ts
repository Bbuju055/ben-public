import { execArgv } from '../lib/exec';
import type { AgentAdapter, AgentRunInput, AgentRunResult } from './types';

/** Pull a JSON object out of a model reply: direct parse, then fenced block, then brace slice. */
export function extractJson(text: string): unknown | undefined {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  return undefined;
}

interface ClaudeJsonOutput {
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
}

export function claudeAdapter(): AgentAdapter {
  return {
    name: 'claude',
    capabilities: ['plan', 'implement'],
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const argv = ['claude', '-p', '--output-format', 'json'];
      if (input.sessionId) argv.push('--resume', input.sessionId);
      if (input.readOnly) {
        argv.push('--permission-mode', 'plan', '--allowedTools', 'Read,Grep,Glob,Task', '--max-turns', '40');
      } else {
        argv.push(
          '--permission-mode',
          'acceptEdits',
          '--allowedTools',
          // node/npx support target repositories that do not use bun,
          // and an implementer that can't run the tests can't self-verify before committing
          'Read,Grep,Glob,Edit,Write,Bash(bun *),Bash(git *),Bash(node *),Bash(npx *)',
          '--max-turns',
          '60',
        );
      }
      argv.push(input.prompt);

      const r = await execArgv(argv, { cwd: input.cwd, timeoutMs: input.timeoutMs });

      let out: ClaudeJsonOutput = {};
      try {
        out = JSON.parse(r.stdout) as ClaudeJsonOutput;
      } catch {
        // non-JSON output (crash, timeout kill) — raw stdout/stderr still returned below
      }
      const resultText = out.result ?? '';
      return {
        ok: r.exitCode === 0 && !r.timedOut,
        raw: r.stdout || r.stderr,
        parsed: resultText ? extractJson(resultText) : undefined,
        sessionId: out.session_id,
        costUsd: out.total_cost_usd ?? 0,
        costIsEstimate: out.total_cost_usd === undefined,
        exitCode: r.timedOut ? 124 : r.exitCode,
      };
    },
  };
}
