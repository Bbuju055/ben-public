import type { BenConfig } from '../src/config';

export default {
  planner: 'claude',
  implementer: 'claude',
  panel: { plan: ['codex'], diff: ['codex'], tieBreak: 'unanimous-go' },
  caps: { planRounds: 3, diffRounds: 3, gateFixes: 2, verifyFixes: 2, humanRounds: 5 },
  budgetUsd: 25,
  maxCriteria: 12,
  // Gates are per-target-repo (one repo per ben instance for now).
  // Retired CLI example for a Bun target; current scripts use per-task .ben/ artifacts.
  gates: {
    typecheck: 'bun run typecheck',
    test: 'bun test',
  },
  e2e: {
    serverCommand: 'bun run dev',
    readyUrl: 'http://localhost:3000',
    video: 'on', // always — the green run's video is the e2e proof
    requiredForPaths: ['src/ui/**', 'app/**'],
  },
  timeoutMinutes: 90,
  agentTimeoutMs: 20 * 60_000,
  gateTimeoutMs: 10 * 60_000,
} satisfies BenConfig;
