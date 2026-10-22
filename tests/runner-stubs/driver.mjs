#!/usr/bin/env node
// Stub driver for runner tests: speaks the `claude -p --output-format stream-json`
// protocol (init + result lines), records its argv, and performs the actions a
// test handler module decides for the given instruction. Never a real model.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const instruction = argv[argv.length - 1];
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = opt('--session-id') ?? opt('--resume');
const resumed = argv.includes('--resume');
const tools = (opt('--tools') ?? '').split(',').filter(Boolean).sort();
const settingsPath = opt('--settings');
const settings = settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : undefined;
const log = process.env.BEN_STUB_DRIVER_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), cwd: process.cwd(), sessionId, resumed, tools, settingsPath, sources: opt('--setting-sources'), maxTurns: opt('--max-turns'), maxBudget: opt('--max-budget-usd'), instruction, env: { GH_TOKEN: process.env.GH_TOKEN ?? null, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? null, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null }, domains: settings?.sandbox?.network?.allowedDomains ?? null, allowWrite: settings?.sandbox?.filesystem?.allowWrite ?? null })}\n`);

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ type: 'system', subtype: 'init', tools, mcp_servers: [], session_id: sessionId, permissionMode: opt('--permission-mode') });

let cost = 0.01;
let text = 'ok';
let isError = false;
let subtype;
let toolOutputs = [];
let extraResults = [];
const handlerPath = process.env.BEN_STUB_DRIVER_HANDLER;
if (handlerPath) {
  const mod = await import(pathToFileURL(handlerPath).href);
  const out = await mod.handle(instruction, { cwd: process.cwd(), sessionId, resumed, settings, env: process.env });
  if (out) {
    cost = out.cost ?? cost;
    text = out.text ?? text;
    isError = out.isError === true;
    subtype = out.subtype;
    toolOutputs = out.toolOutputs ?? [];
    extraResults = out.extraResults ?? [];
    if (out.hang) {
      // simulate a stretch that never ends (the runner's timeout must kill the process group)
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    if (out.crash) process.exit(out.crash);
  }
}
for (const t of toolOutputs) emit({ type: 'user', message: { content: [{ type: 'tool_result', content: t }] } });
emit({ type: 'result', subtype: subtype ?? (isError ? 'error' : 'success'), is_error: isError, total_cost_usd: cost, num_turns: 3, session_id: sessionId, result: text });
for (const result of extraResults) emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, ...result });
process.exit(isError ? 1 : 0);
