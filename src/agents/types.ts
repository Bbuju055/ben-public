export interface AgentRunInput {
  prompt: string;
  cwd: string;
  schemaPath?: string;
  sessionId?: string;
  timeoutMs: number;
  readOnly: boolean;
  /** file paths to inline into the prompt */
  attachments?: string[];
}

export interface AgentRunResult {
  ok: boolean;
  raw: string;
  parsed?: unknown;
  sessionId?: string;
  /** reported if available, otherwise estimated; adapters may fall back to zero with estimate metadata */
  costUsd: number;
  costIsEstimate: boolean;
  exitCode: number;
}

export interface AgentAdapter {
  name: string;
  capabilities: Array<'plan' | 'implement' | 'review'>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
