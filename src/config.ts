export interface E2eConfig {
  serverCommand: string;
  readyUrl: string;
  video: 'on';
  requiredForPaths: string[];
}

export interface PanelConfig {
  /** adapter names reviewing the plan; empty = skip REVIEW_PLAN */
  plan: string[];
  /** adapter names reviewing the diff; empty = skip REVIEW_DIFF */
  diff: string[];
  /** unanimous-go: every panelist must return GO; any ABSTAIN with no blockers escalates */
  tieBreak: 'unanimous-go';
}

export interface BenConfig {
  planner: string;
  implementer: string;
  panel: PanelConfig;
  caps: {
    planRounds: number;
    diffRounds: number;
    gateFixes: number;
    verifyFixes: number;
    humanRounds: number;
  };
  budgetUsd: number;
  maxCriteria: number;
  /** Gate name -> shell command, run in the worktree. All must exit 0. */
  gates: Record<string, string>;
  e2e: E2eConfig;
  timeoutMinutes: number;
  agentTimeoutMs: number;
  gateTimeoutMs: number;
}
