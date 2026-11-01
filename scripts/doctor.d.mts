export interface CommandResult { code: number | null; out: string; err: string; problem?: string }
export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export type Command = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;
export interface Options { repo?: string; online?: boolean; json?: boolean }
export interface Check { id: string; status: 'pass' | 'fail' | 'unknown' | 'skipped'; required: boolean; detail: string; remedy: string }
export interface Report { schemaVersion: number; scope: { repo: boolean; online: boolean }; checks: Check[]; limitations: string[]; exitCode: number }
export const RUNTIME_FILES: string[];
export const runCommand: Command;
export function parseArgs(args: string[]): Options;
export function inspect(options?: Options, context?: { root?: string; home?: string; platform?: string; nodeVersion?: string; sandbox?: string; run?: Command }): Promise<Report>;
export function main(args?: string[]): Promise<number>;
