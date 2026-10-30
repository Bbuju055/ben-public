import type { CiTarget, CiObservation } from './ci.lib.mjs';
export const CI_POLL: Readonly<{ attempts: number; intervalMs: number; windowMs: number; collectionMs: number }>;
export function scheduledCi(home: string, repo: string, target: CiTarget | undefined): (CiObservation & { invalid?: true }) | undefined;
export function observeCi(options: {
  home: string; repo: string; snapshot: () => { task: unknown; localHead: string } | undefined;
  get: (path: string, options: { timeoutMs: number }) => unknown; now?: () => number; monotonic?: () => number;
}): { state: string; attempts?: number; nextAt?: number; observation?: CiObservation };
