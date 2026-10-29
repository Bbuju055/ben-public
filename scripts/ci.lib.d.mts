export interface CiTarget { repo: string; number: number; prUrl: string; reviewedSha: string }
export interface CiObservation {
  version: number; policy: string; repo: string; number: number; prUrl: string;
  reviewedSha: string; observedHeadSha: string | null; observedAt: string;
  state: string; reason: string; sources: string[];
  checks: { kind: string; id: number; name: string; state: string; url: string; appId?: number; suiteId?: number }[];
}
export function ciTarget(task: unknown): CiTarget | undefined;
export function collectCi(target: CiTarget, get: (path: string) => unknown, now?: () => string): CiObservation;
export function ciForStatus(observation: unknown, target: CiTarget | undefined, localHead: string): { state: string; reason: string; reviewedSha: string | null; observedAt: string | null; checks: unknown[] };
