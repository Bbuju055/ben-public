// Hand-maintained declarations for scripts/adjudication.lib.mjs — the typed
// boundary tests import against. Keep in lockstep with the implementation.

export function readReviewOutput(path: string): string;

export interface AdjudicationBasis {
  kind: 'plan' | 'diff';
  round: number;
  fingerprint: string;
  action: string;
}

export interface AdjudicationRecord {
  type: 'adjudication';
  criterionId: string;
  criterionSha: string;
  criterion: Record<string, unknown>;
  approvalActSha: string;
  headSha: string;
  decision: 'satisfied' | 'accepted';
  ruling: string;
  residual?: string;
  basis?: AdjudicationBasis;
  basisEntry?: Record<string, unknown>;
  by: string;
  at: string;
}

export declare const EMPTY_SHA256: string;
export declare function sha256(bytes: string | Uint8Array): string;
export declare function stableStringify(v: unknown): string;
export declare function criterionShaOf(criterion: unknown): string;
export declare function validateAdjudicationRecord(record: unknown): string[];
export declare function recordBindingKey(record: AdjudicationRecord): string;
export declare function recordContentKey(record: AdjudicationRecord): string;
export declare function classifyRecords(a: AdjudicationRecord, b: AdjudicationRecord): 'replay' | 'conflict' | 'coexistence';
export declare function recordDigest(record: AdjudicationRecord): string;
export declare function governingSelection(
  records: AdjudicationRecord[],
  opts: { criteriaDoc?: unknown; approvalBytes?: Uint8Array; getHeadSha: () => string },
): Map<string, AdjudicationRecord>;
export declare function adjudicationsShaOf(governing: Map<string, AdjudicationRecord>): string;
export declare function ledgerAdjudicationRecords(ledgerEntries: unknown[]): AdjudicationRecord[];
export declare function checkRegisterAgainstLedger(records: AdjudicationRecord[], ledgerEntries: unknown[]): void;
export declare function deriveAdjudication(opts: {
  stateDir: string;
  ledgerEntries: unknown[];
  criteriaDoc?: unknown;
  approvalBytes?: Uint8Array;
  getHeadSha: () => string;
}): { records: AdjudicationRecord[]; governing: Map<string, AdjudicationRecord>; digest: string };
export declare function validateAuditEntry(entry: unknown): string[];
export declare function assertInertAuditRows(ledgerEntries: unknown[]): void;
export declare function assertBasisProvenance(records: AdjudicationRecord[], ledgerEntries: unknown[]): void;
export declare function assertNoRegisterConflicts(records: AdjudicationRecord[]): void;
export declare function isValidTimestamp(s: unknown): boolean;
export declare function adjudicationDetail(record: AdjudicationRecord): string;
export declare function publicationDetail(p: Record<string, string>): string;
export declare const APPROVAL_FILES: string[];
export declare function canonicalConfig(task: unknown): string;
export declare function approvalHashesFor(stateDir: string, task: unknown): Record<string, string> | undefined;
export declare function approvalStateFor(stateDir: string, task: unknown): { present: boolean; approval?: Record<string, unknown>; matches?: boolean; complete?: boolean };
export declare const SEQUENCER_VERSION: number;
export declare function validSequencerTask(t: unknown): boolean;
export declare function readLedgerStrict(ledgerPath: string): unknown[];
export declare function taskPrShapeIssues(pr: unknown): string[];
export declare function assertAdjudicationActAllowed(opts: { stateDir: string; repoDir?: string; task: unknown; record: AdjudicationRecord }): void;
export declare function assertAttestationAllowed(opts: { stateDir: string; repoDir?: string; task: unknown; publication: Record<string, string> }): void;
export declare function approvalRelevantLedgerSha(ledgerPath: string): string;
export declare function ledgerStampMatches(stored: string, current: string): boolean;
export declare function canonicalBody(text: string): string;
export declare function resolveRepoForState(stateDir: string, explicitRepo?: string): string | undefined;
export declare function renderPrBody(stateDir: string, opts: { title: string; repoDir?: string }): string;

export interface WaitingOption {
  token: string;
  label: string;
  effect: string;
  command: string;
}
export interface WaitingRecord {
  kind: string;
  owner: 'human' | 'model' | 'playbook';
  question: string;
  why: string;
  options: WaitingOption[];
  binding: Record<string, unknown>;
  inputsDigest?: string;
  notes?: string;
  packet: string;
  at: string;
}
export type WaitingStateResult =
  | { state: 'absent' }
  | { state: 'stale' | 'spent'; reason: string }
  | { state: 'current'; waiting: WaitingRecord; derived: Record<string, unknown> };
export declare const WAITING_JSON: string;
export declare const WAITING_MD: string;
export declare const WAITING_CORE_FILES: string[];
export declare function waitingInputsDigest(stateDir: string, inputs: string[]): string;
export declare function waitingGitIdentity(repoDir: string): { headSha: string; worktreeHash: string };
export declare function waitingState(stateDir: string, repoDir?: string): WaitingStateResult;

// Runner task shapes and publication limits.
export declare const PUBLICATION_MODES: string[];
export declare const LIMIT_KINDS: string[];
export declare const INSPECTION_BRANCH: string[];
export declare const INSPECTION_PR: string[];
export declare const FIX_GRANT_STEPS: string[];
export declare const PR_INSPECTION_FAILURE_MAX: number;
export declare const PR_TITLE_MAX: number;
export declare function prTitleFor(title: unknown, max?: number): string;
export declare function assignmentIssues(a: unknown): string[];
export declare function item16TaskIssues(t: unknown): string[];
export declare function gateIdFor(assignmentId: string, seq: number, kind: string, binding: unknown): string;
export declare function openSupervisorStop(task: unknown): Record<string, unknown> | undefined;
export declare function openLimitEvent(task: unknown): Record<string, unknown> | undefined;
export declare function higherPrecedenceIssue(task: unknown): string | undefined;
export declare function latestInspection(task: unknown, intentHash: string): Record<string, unknown> | undefined;
export declare function inspectionSha(inspection: unknown): string;
export declare function pendingClarification(stateDir: string, task: unknown): boolean;
