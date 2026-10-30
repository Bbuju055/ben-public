export interface NotificationEvent {
  version: number; id: string; kind: string; reason: string; repo: string; assignmentId: string;
  prUrl?: string; reviewedSha?: string; gateId?: string; observedAt?: string;
}
export function notificationEvent(repo: string, status: any, runnerState?: any): NotificationEvent | null;
export function commandSink(config: { argv: string[] }, event: NotificationEvent): boolean;
export function reconcileNotifications(options: {
  home: string; repo: string; snapshot: () => {status: any; runnerState?: any} | undefined;
  now?: () => number; send?: (config: {argv: string[]}, event: NotificationEvent) => boolean;
}): {state: string; attempts?: number; nextAt?: number};
