import type { AgentAdapter } from './types';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';

/** name -> adapter. */
export function defaultAdapters(): Record<string, AgentAdapter> {
  return { claude: claudeAdapter(), codex: codexAdapter() };
}
