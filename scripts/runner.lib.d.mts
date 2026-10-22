// Hand-maintained declarations for scripts/runner.lib.mjs — the typed
// boundary tests import against. Keep in lockstep with the implementation.

export declare const BEN_DIR: string;
export declare const CREDENTIAL_READ_DENY: string[];
export declare function sha256(bytes: string | Uint8Array): string;
export declare function isObj(v: unknown): boolean;
export declare function isBlank(v: unknown): boolean;
export declare function realOrResolved(p: string): string;
export declare function renderGateProfile(opts: {
  repo: string;
  runnerHome?: string;
  benDir?: string;
  runtimeDir?: string;
  tmpDir?: string;
  extraProtected?: string[];
  allowNetwork?: boolean;
  home?: string;
}): string;
export declare function gateWrapperArgv(profilePath: string): string[];
export declare function readJsonIfExists(path: string): unknown;

export declare const DRIVER_DENIED_BEN_ENTRIES: string[];
export declare const STRETCH_MODES: string[];
export declare const DRIVER_TOOLS: string;
export declare const HEADLESS_DRIVER_PROTOCOL: string;
export declare const GIT_CONFIG_ALLOWLIST: RegExp;
export declare const DEFAULT_LIMITS: { usd: number; hours: number; stretches: number };
export declare const DEFAULT_STRETCH: { maxTurns: number; maxBudgetUsd: number; timeoutMs: number };
export declare const REVIEWER_CALL_ESTIMATE_USD: number;
export declare const PUBLICATION_TIMEOUT_MS: number;
export declare const STATES: string[];
export declare function renderDriverSettings(opts: {
  repo: string;
  benDir?: string;
  runtimeDir?: string;
  runnerHome?: string;
  home?: string;
  mode?: string;
  allowedDomains?: string[];
  registries?: string[];
}): Record<string, unknown>;
export declare function driverArgv(opts: {
  settingsPath: string;
  sessionId: string;
  resume?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt: string;
  instruction: string;
  tools?: string;
}): string[];
export declare function scrubbedDriverEnv(base: Record<string, string | undefined>, opts: { ghEmptyDir: string; extra?: Record<string, string> }): Record<string, string>;
export declare function configurationProblems(opts: {
  repo?: string;
  expectedRemoteUrl?: string;
  gitConfigList?: string;
  managedSettingsText?: string;
  hookEntries?: string[];
  claudeEntries?: string[];
  hasMcpJson?: boolean;
}): string[];
export declare function ownerRepoFromUrl(url: string | undefined): string | undefined;
export declare function parseJsonl(text: string): Array<Record<string, unknown>>;
export declare function accountTotals(
  rows: Array<Record<string, unknown>>,
  opts?: { reviewerEstimateUsd?: number; stretchCapUsd?: number; stretchTimeoutMs?: number; nextTimeoutMs?: number; publicationTimeoutMs?: number; inFlightId?: string; live?: boolean; now?: number },
): {
  usd: number;
  inFlightCapUsd: number;
  exactUsd: number;
  cappedUsd: number;
  reviewerUsd: number;
  reviewerCalls: number;
  unreportedStretches: number;
  stretches: number;
  activeMs: number;
  unreportedChildren: number;
  sleepMs: number;
};
export declare function effectiveLimits(task: unknown): { usd: number; hours: number; stretches: number };
export declare function reachedLimit(totals: { usd: number; activeMs: number; stretches: number }, limits: { usd: number; hours: number; stretches: number }): { kind: string; value: number } | undefined;
export declare function stripPresentation(task: unknown): unknown;
export declare function progressIdentity(opts: { stateDir: string; headSha: string; worktreeStatus: string; worktreeDiff: string; ledgerLines: number; extraFiles?: string[] }): string;
export declare function judgeProbe(opts: {
  transcript: Array<Record<string, unknown>>;
  expectedTools?: string[];
  canaryBefore?: Uint8Array | string;
  canaryAfter?: Uint8Array | string;
  secret?: string;
  listenerHits?: number;
  canaries?: { writePath?: string; readPath?: string; listener?: string; network?: string };
}): { ok: boolean; problems: string[] };
export declare function sleepGapMs(opts: { wallStart: number; monoStartMs: number; wallNow: number; monoNowMs: number; previouslyCounted?: number }): number;
export declare function planDependenciesSection(planText: string): string | undefined;
export declare function classifyStatus(opts: {
  status: Record<string, unknown> | undefined;
  runnerAlive: boolean;
  runnerState?: Record<string, unknown>;
  lastActivityMs?: number;
  stretchTimeoutMs?: number;
}): { state: string; detail: string };
export declare function scrubForOperator(text: unknown, max?: number): string;

export declare function failureKind(text: string): 'session' | 'auth' | 'transient' | 'fatal';
export declare function researchFiles(dir: string): string[];
