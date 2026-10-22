// runner.lib — pure helpers for scripts/runner.mjs. Zero dependencies.
// Nothing here sequences, judges, or records a human decision; these are the
// runner's mechanical text/path/accounting functions, importable by tests.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEN_DIR = realpathSync(resolvePath(dirname(fileURLToPath(import.meta.url)), '..'));

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isBlank(v) {
  return typeof v !== 'string' || v.trim().length === 0;
}

/** realpath when the path exists, else the resolved path (sandbox filters match real paths). */
export function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/** SBPL string literal — quotes and backslashes escaped. */
function sb(s) {
  return `"${String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// credential paths denied for reads inside every sandboxed child
export const CREDENTIAL_READ_DENY = ['.config/gh', '.git-credentials', '.netrc', '.ssh', '.aws', '.codex', '.config/codex', '.claude/.credentials.json'];

/**
 * The gate-command Seatbelt profile: writes only inside the repo
 * tree minus the protected classes, plus the referee's scratch subtree and
 * $TMPDIR; credential reads denied; network denied unless the task granted
 * it (all-or-nothing). Later rules win in SBPL, so allows come first and the
 * protected denies last. Every path is a realpath.
 */
export function renderGateProfile({ repo, runnerHome = join(homedir(), '.ben-runner'), benDir = BEN_DIR, runtimeDir = undefined, tmpDir = process.env.TMPDIR ?? '/tmp', extraProtected = [], allowNetwork = false, home = homedir() }) {
  const R = realOrResolved(repo);
  const S = join(R, '.ben');
  // when ben builds ben the install IS the target checkout: it stays writable
  // (the pinned runtime, protected below, is what trusted processes execute)
  const benReal = realOrResolved(benDir);
  const benOutside = benReal !== R && !benReal.startsWith(`${R}/`);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "/dev") (subpath ${sb(realOrResolved(tmpDir))}))`,
    `(allow file-write* (subpath ${sb(R)}))`,
    // the complete protection boundary — repository code must not modify
    // anything a later trusted process executes or reads with broader authority
    `(deny file-write* (subpath ${sb(S)}))`,
    `(allow file-write* (subpath ${sb(join(S, 'evidence', 'scratch'))}))`,
    `(deny file-write* (subpath ${sb(join(R, '.git', 'hooks'))}) (subpath ${sb(join(R, '.git', 'info'))}) (literal ${sb(join(R, '.git', 'config'))}) (subpath ${sb(join(R, '.claude'))}) (literal ${sb(join(R, '.mcp.json'))}))`,
    `(deny file-write* (subpath ${sb(realOrResolved(runnerHome))}) (subpath ${sb(join(home, '.claude'))})${benOutside ? ` (subpath ${sb(benReal)})` : ''}${runtimeDir ? ` (subpath ${sb(realOrResolved(runtimeDir))})` : ''})`,
    ...extraProtected.map((p) => `(deny file-write* (subpath ${sb(realOrResolved(p))}))`),
    `(deny file-read* ${CREDENTIAL_READ_DENY.map((p) => `(subpath ${sb(join(home, p))})`).join(' ')})`,
  ];
  if (!allowNetwork) {
    lines.push(
      '(deny network*)',
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network* (local unix-socket) (remote unix-socket))',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The wrapper argv verify.mjs receives (JSON-encoded by the caller). */
export function gateWrapperArgv(profilePath) {
  return ['/usr/bin/sandbox-exec', '-f', profilePath];
}

export function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// the driver settings file (sandbox + harness rules), per stretch mode

/** Authoritative `.ben` entries the driver must never write (everything else in .ben is driver input). */
export const DRIVER_DENIED_BEN_ENTRIES = [
  'task.json',
  'approval.json',
  'ledger.jsonl',
  'rounds.json',
  'veto.jsonl',
  'adjudications.json',
  'blockers.json',
  'evidence',
  'reviews',
  'runner',
  'runner.lock',
  '.run-lock',
  'last-next.json',
  'waiting.json',
  'WAITING.md',
  'pr-body.md',
  'remote-observation.json',
  'plan.reviewed.md',
  'criteria.reviewed.json',
  'promises.reviewed.json',
  'plan-files.reviewed.json',
  'gates.reviewed.json',
  'config.reviewed.json',
  'ABANDON.md',
  'hook-state.json',
  'history',
  'lineage.json',
];
// the regex-like glob for superseded approvals is expressed as a deny on the directory pattern below

export const STRETCH_MODES = ['work', 'install', 'research', 'probe'];

/**
 * Render the `--settings` JSON for a driver stretch. `mode`:
 * work    — the profile (writes inside the tree minus the deny list; network = allowDomains)
 * install — work + package caches + $TMPDIR writable; network = registries
 * research — writes ONLY under .ben/research/; network = researchDomains
 *  probe    — work with no domains (the launch probe)
 */
export function renderDriverSettings({ repo, benDir = BEN_DIR, runtimeDir, runnerHome = join(homedir(), '.ben-runner'), home = homedir(), mode = 'work', allowedDomains = [], registries = ['registry.npmjs.org', '*.jsdelivr.net', 'registry.yarnpkg.com'] }) {
  if (!STRETCH_MODES.includes(mode)) throw new Error(`unknown stretch mode ${mode}`);
  const R = realOrResolved(repo);
  const S = join(R, '.ben');
  const denyWrite = [
    ...DRIVER_DENIED_BEN_ENTRIES.map((e) => join(S, e)),
    join(R, '.claude'),
    join(R, '.mcp.json'),
    join(R, '.git', 'config'),
    join(R, '.git', 'hooks'),
    join(R, '.git', 'info'),
    realOrResolved(runnerHome),
    join(home, '.claude'),
    ...(runtimeDir ? [realOrResolved(runtimeDir)] : []),
  ];
  const outsideRepo = (p) => !realOrResolved(p).startsWith(`${R}/`) && realOrResolved(p) !== R;
  if (outsideRepo(benDir)) denyWrite.push(realOrResolved(benDir));
  const denyRead = CREDENTIAL_READ_DENY.map((p) => `~/${p}`);
  const editDeny = (p) => [`Edit(${p})`, `Edit(${p}/**)`];
  const readDeny = CREDENTIAL_READ_DENY.flatMap((p) => [`Read(~/${p})`, `Read(~/${p}/**)`, `Read(//${join(home, p)})`, `Read(//${join(home, p)}/**)`]);
  const permissionsDeny = [
    ...denyWrite.flatMap((p) => editDeny(`//${p}`)),
    ...DRIVER_DENIED_BEN_ENTRIES.flatMap((e) => editDeny(`.ben/${e}`)),
    'Edit(.ben/approval.superseded-*)',
    'Edit(.claude/**)',
    'Edit(.mcp.json)',
    // NOT `Edit(.git/**)`: Claude mirrors Edit() denies into the OS sandbox,
    // which made the whole .git dir read-only for Bash (no commits) on the
    // the protected .git paths are exactly config/hooks/info
    'Edit(.git/config)',
    'Edit(.git/hooks/**)',
    'Edit(.git/info/**)',
    ...readDeny,
    'Bash(node * run.mjs record*)',
    'Bash(node * run.mjs answer*)',
    'Bash(node * run.mjs next*)',
    'Bash(node * run.mjs init*)',
    'Bash(node * run.mjs adopt*)',
    'Bash(node * runner.mjs*)',
    'Bash(* run.mjs record*)',
    'Bash(* run.mjs answer*)',
    'Bash(* run.mjs next*)',
    'Bash(* runner.mjs*)',
    'Bash(git push*)',
    'Bash(gh *)',
    'Bash(codex *)',
    'Bash(claude *)',
  ];
  const allowWrite = [];
  let domains = mode === 'probe' ? [] : mode === 'install' ? [...registries] : mode === 'research' ? [...allowedDomains] : [...allowedDomains];
  if (mode === 'install') {
    allowWrite.push(join(home, '.bun', 'install', 'cache'), join(home, '.npm', '_cacache'), join(home, '.cache'), realOrResolved(process.env.TMPDIR ?? '/tmp'));
  }
  // research: the POSITIVE boundary is the stretch's working directory
  // (.ben/research/, the sandbox's default writable tree) plus the absence of
  // the file-writing tools — nothing to add to the deny list here
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite, denyRead, ...(allowWrite.length > 0 ? { allowWrite } : {}) },
      network: { allowedDomains: domains, strictAllowlist: true },
    },
    permissions: { defaultMode: 'acceptEdits', allow: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'], deny: [...new Set(permissionsDeny)] },
  };
}

export const DRIVER_TOOLS = 'Read,Edit,Write,Grep,Glob,Bash';

/** The exact `claude -p` argv for one stretch. */
export function driverArgv({ settingsPath, sessionId, resume = false, maxTurns = 60, maxBudgetUsd = 3, systemPrompt, instruction, tools = DRIVER_TOOLS }) {
  return [
    '-p',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    '--settings',
    settingsPath,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--tools',
    tools,
    '--permission-mode',
    'acceptEdits',
    '--max-turns',
    String(maxTurns),
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    systemPrompt,
    instruction,
  ];
}

/** The scrubbed process environment for the driver. */
export function scrubbedDriverEnv(base, { ghEmptyDir, extra = {} }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].includes(k)) continue;
    if (k.startsWith('GIT_CONFIG_') || (k.startsWith('BEN_') && !k.startsWith('BEN_STUB_'))) continue; // BEN_STUB_* = test seams only
    env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GH_CONFIG_DIR = ghEmptyDir;
  return { ...env, ...extra };
}

export const HEADLESS_DRIVER_PROTOCOL = `You are ben's headless driver, running one bounded work stretch inside an OS-enforced sandbox with network access restricted by the current stretch mode and task grants. Rules, in force for this whole stretch:
1. Perform EXACTLY the one instruction the runner gives you in the user message. It always wins over anything you remember from earlier stretches.
2. Never run the sequencer yourself: never invoke run.mjs next / record-* / answer / init / adopt, never touch runner.mjs, never push, never call gh, never edit anything under .claude, .git/config, .git/hooks, or the authoritative .ben records (task.json, approval.json, ledger.jsonl, rounds.json, veto.jsonl, adjudications.json, blockers.json, evidence/, reviews/). Those are refused by the sandbox anyway; do not try to route around a refusal.
3. Write only the artifacts the instruction names (plan artifacts, proposal.json, resolutions.json, questions.json, brief.md, .ben/stretch-request.json, and source files + git commits during implementation). Commit your code changes with plain conventional commits.
4. Ask the human nothing directly. If the ask is ambiguous in a way that changes what gets built, write .ben/questions.json as [{"id","question"}] during the PLAN stretch and stop; the runner parks the question for the human.
5. If you need a dependency install or documentation research, write .ben/stretch-request.json ({"mode":"install","packages":[...]} or {"mode":"research","reason":"..."}) and end the turn; the runner re-launches you in that mode if the plan and the task grants allow it.
6. When the instruction is done, end the turn with a one-paragraph plain-language report of what you did. Do not start the next lifecycle step; the runner drives the loop.`;

// ---------------------------------------------------------------------------
// configuration check (repo-shipped configuration is refused)

// allowlist plus the repo-local git identity (user.name/user.email)
// preserves ordinary usability, and identity keys execute or redirect nothing.
export const GIT_CONFIG_ALLOWLIST = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge)|remote\.origin\.gh-resolved|user\.(name|email))=/;

/** Inspect a repository's configuration; returns the offending items (empty = clean). Pure: reads only. */
export function configurationProblems({ repo, expectedRemoteUrl, gitConfigList, managedSettingsText, hookEntries, claudeEntries, hasMcpJson }) {
  const problems = [];
  for (const e of claudeEntries ?? []) problems.push(`repository ships Claude configuration: .claude/${e}`);
  if (hasMcpJson) problems.push('repository ships .mcp.json (MCP servers)');
  for (const h of hookEntries ?? []) problems.push(`repository has an active git hook: .git/hooks/${h}`);
  for (const line of (gitConfigList ?? '').split('\n').filter((l) => l.trim() !== '')) {
    if (!GIT_CONFIG_ALLOWLIST.test(line)) problems.push(`.git/config key outside the allowlist: ${line}`);
  }
  if (expectedRemoteUrl !== undefined) {
    const m = (gitConfigList ?? '').split('\n').find((l) => l.startsWith('remote.origin.url='));
    const url = m === undefined ? undefined : m.slice('remote.origin.url='.length);
    if (url !== expectedRemoteUrl) problems.push(`remote.origin.url is ${url ?? '(absent)'} — recorded at assign: ${expectedRemoteUrl}`);
  }
  if (managedSettingsText !== undefined) {
    try {
      const m = JSON.parse(managedSettingsText);
      if (m.hooks !== undefined) problems.push('managed settings define hooks');
      if (m.sandbox?.excludedCommands !== undefined) problems.push('managed settings define sandbox.excludedCommands');
      if (m.sandbox?.allowUnsandboxedCommands !== undefined) problems.push('managed settings define sandbox.allowUnsandboxedCommands');
      if (m.sandbox?.filesystem?.disabled !== undefined) problems.push('managed settings define sandbox.filesystem.disabled');
    } catch {
      problems.push('managed settings file is unreadable JSON');
    }
  }
  return problems;
}

/** owner/repo from a GitHub remote URL (https or ssh); undefined when unparseable. */
export function ownerRepoFromUrl(url) {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ---------------------------------------------------------------------------
// limits contract — accounting over .ben/runner/stretches.jsonl

export const DEFAULT_LIMITS = { usd: 25, hours: 8, stretches: 40 };
export const DEFAULT_STRETCH = { maxTurns: 60, maxBudgetUsd: 3, timeoutMs: 45 * 60 * 1000 };
export const REVIEWER_CALL_ESTIMATE_USD = 0.5;
export const PUBLICATION_TIMEOUT_MS = 5 * 60 * 1000;

export function parseJsonl(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { type: 'torn', raw: l };
      }
    });
}

/**
 * The accounted totals (accounting thresholds): exact stretch costs,
 * launched-without-completion charged at cap, reviewer launches at the
 * per-call estimate, active time = summed child wall time minus recorded
 * sleep gaps, unreported children charged at their timeout.
 */
export function accountTotals(rows, { reviewerEstimateUsd = REVIEWER_CALL_ESTIMATE_USD, stretchCapUsd = DEFAULT_STRETCH.maxBudgetUsd, stretchTimeoutMs = DEFAULT_STRETCH.timeoutMs, nextTimeoutMs = 30 * 60 * 1000, publicationTimeoutMs = PUBLICATION_TIMEOUT_MS, inFlightId = undefined, live = false, now = Date.now() } = {}) {
  // inFlightId: the stretch a LIVE runner is executing right now — reserved
  // (its cap is shown separately), not "unreported"; its time counts as elapsed
  const launched = new Map();
  const completed = new Map();
  const started = new Map();
  const ended = new Map();
  let reviewerCalls = 0;
  let sleepMs = 0;
  for (const r of rows) {
    if (r.type === 'launched') launched.set(r.id, r);
    else if (r.type === 'completed') completed.set(r.id, r);
    else if (r.type === 'started') started.set(r.id, r);
    else if (r.type === 'ended') ended.set(r.id, r);
    else if (r.type === 'reviewer-launch') reviewerCalls += 1;
    else if (r.type === 'sleep-gap') sleepMs += Number(r.ms) || 0;
  }
  let exactUsd = 0;
  let cappedUsd = 0;
  let unreported = 0;
  let stretches = 0;
  let inFlightCapUsd = 0;
  for (const [id, l] of launched) {
    stretches += 1;
    const c = completed.get(id);
    if (c !== undefined && typeof c.costUsd === 'number' && Number.isFinite(c.costUsd)) exactUsd += c.costUsd;
    else if (id === inFlightId) inFlightCapUsd += typeof l.capUsd === 'number' ? l.capUsd : stretchCapUsd;
    else {
      unreported += 1;
      cappedUsd += typeof l.capUsd === 'number' ? l.capUsd : stretchCapUsd;
    }
  }
  const reviewerUsd = reviewerCalls * reviewerEstimateUsd;
  let activeMs = 0;
  let unreportedTime = 0;
  for (const [id, s] of started) {
    const e = ended.get(id);
    if (e !== undefined && typeof e.ms === 'number') activeMs += e.ms;
    else if (id === inFlightId || (live && s.kind !== 'stretch' && Date.parse(s.at ?? '') > 0 && now - Date.parse(s.at) < nextTimeoutMs)) {
      // a LIVE runner's open child: elapsed so far, not its timeout
      activeMs += Math.max(0, now - (Date.parse(s.at ?? '') || now));
    } else {
      unreportedTime += 1;
      activeMs += s.kind === 'stretch' ? (typeof s.timeoutMs === 'number' ? s.timeoutMs : stretchTimeoutMs) : s.kind === 'publication' ? publicationTimeoutMs : nextTimeoutMs;
    }
  }
  activeMs = Math.max(0, activeMs - sleepMs);
  return {
    usd: exactUsd + cappedUsd + reviewerUsd,
    inFlightCapUsd,
    exactUsd,
    cappedUsd,
    reviewerUsd,
    reviewerCalls,
    unreportedStretches: unreported,
    stretches,
    activeMs,
    unreportedChildren: unreportedTime,
    sleepMs,
  };
}

/** Effective budgets = assignment limits + recorded extensions. */
export function effectiveLimits(task) {
  const base = task?.assignment?.limits ?? DEFAULT_LIMITS;
  const ext = Array.isArray(task?.limitExtensions) ? task.limitExtensions : [];
  const sum = (kind) => ext.filter((e) => e.kind === kind).reduce((a, e) => a + e.amount, 0);
  return { usd: base.usd + sum('usd'), hours: base.hours + sum('time'), stretches: base.stretches + sum('stretches') };
}

/** Which limit (if any) the accounted totals have reached; undefined when none. */
export function reachedLimit(totals, limits) {
  if (totals.usd >= limits.usd) return { kind: 'usd', value: Math.round(totals.usd * 100) / 100 };
  if (totals.activeMs >= limits.hours * 3600 * 1000) return { kind: 'time', value: Math.round((totals.activeMs / 3600000) * 100) / 100 };
  if (totals.stretches >= limits.stretches) return { kind: 'stretches', value: totals.stretches };
  return undefined;
}

// ---------------------------------------------------------------------------
// progress identity (semantic state only; presentation bookkeeping excluded)

const PROGRESS_FILES = ['plan.md', 'criteria.json', 'promises.json', 'plan-files.json', 'gates.json', 'proposal.json', 'resolutions.json', 'questions.json', 'stretch-request.json', 'rounds.json', 'blockers.json', 'approval.json', 'adjudications.json', 'brief.md'];

export function stripPresentation(task) {
  if (!isObj(task)) return task;
  const out = {};
  for (const [k, v] of Object.entries(task)) {
    if (k === 'gate' || k === 'gateSeq' || k === 'supervisorStops') continue; // presentation + the guard's own bookkeeping
    if (/^at$|At$/.test(k) && typeof v === 'string') continue;
    out[k] = Array.isArray(v) ? v.map(stripPresentation) : isObj(v) ? stripPresentation(v) : v;
  }
  return out;
}

export function progressIdentity({ stateDir, headSha, worktreeStatus, worktreeDiff, ledgerLines, extraFiles = [] }) {
  const parts = [`head:${headSha}`, `status:${sha256(`${worktreeStatus}\n${worktreeDiff}`)}`, `ledger:${ledgerLines}`];
  for (const f of PROGRESS_FILES) {
    let content;
    try {
      content = readFileSync(join(stateDir, f));
    } catch {
      parts.push(`${f}:ABSENT`);
      continue;
    }
    parts.push(`${f}:${sha256(content)}`);
  }
  // Only caller-selected paths: never follow symlinks or traverse home/dependencies.
  for (const path of [...new Set(extraFiles)].sort().slice(0, 256)) {
    try {
      const st = lstatSync(path);
      if (st.isFile() && realpathSync(path) === resolvePath(path) && st.size <= 1024 * 1024) parts.push(`artifact:${path}:${sha256(readFileSync(path))}`);
    } catch { /* absent or concurrently replaced: the next observation rechecks */ }
  }
  let task;
  try {
    task = JSON.parse(readFileSync(join(stateDir, 'task.json'), 'utf8'));
  } catch {
    task = undefined;
  }
  parts.push(`task:${task === undefined ? 'ABSENT' : sha256(JSON.stringify(stripPresentation(task)))}`);
  return sha256(parts.join('|'));
}

// ---------------------------------------------------------------------------
// launch-time probe — judged from tool/process evidence and canary state

/**
 * launch probe verdict — from tool/process evidence only, never from the
 * driver's prose: every specified canary must appear as a Bash tool_use whose
 * tool_result carries the refusal/violation; the Read-tool attempt must be
 * refused; the canary file must be byte-identical; the secret must appear in
 * no tool output; the listener must have received nothing.
 */
export function judgeProbe({ transcript, expectedTools = DRIVER_TOOLS.split(','), canaryBefore, canaryAfter, secret, listenerHits, canaries = {} }) {
  const problems = [];
  const init = transcript.find((l) => l?.type === 'system' && l?.subtype === 'init');
  if (init === undefined) problems.push('no init message in the transcript');
  else {
    const tools = [...(init.tools ?? [])].sort();
    if (JSON.stringify(tools) !== JSON.stringify([...expectedTools].sort())) problems.push(`tool set is ${tools.join(',')} — expected exactly ${expectedTools.join(',')}`);
    if (Array.isArray(init.mcp_servers) && init.mcp_servers.length > 0) problems.push(`MCP servers present: ${init.mcp_servers.map((m) => m.name ?? '?').join(',')}`);
  }
  // pair every tool_use with its tool_result by id
  const uses = new Map();
  const results = new Map();
  for (const l of transcript) {
    if (l?.type === 'assistant' && Array.isArray(l.message?.content)) for (const c of l.message.content) if (c?.type === 'tool_use') uses.set(c.id, c);
    if (l?.type === 'user' && Array.isArray(l.message?.content)) for (const c of l.message.content) if (c?.type === 'tool_result') results.set(c.tool_use_id, typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''));
  }
  const allResults = [...results.values()].join('\n');
  const bashCall = (needle) => [...uses.values()].find((u) => u.name === 'Bash' && typeof u.input?.command === 'string' && u.input.command.includes(needle));
  const need = (name, needle, resultRe) => {
    const u = bashCall(needle);
    if (u === undefined) return problems.push(`no Bash tool call attempted the ${name} canary (${needle})`);
    const r = results.get(u.id);
    if (r === undefined) return problems.push(`the ${name} canary call has no tool result`);
    if (!resultRe.test(r)) problems.push(`the ${name} canary was not refused as required: ${r.slice(0, 160).replace(/\n/g, ' | ')}`);
  };
  if (canaries.writePath) need('protected-write', canaries.writePath, /Operation not permitted|operation not permitted|EPERM/i);
  if (canaries.readPath) need('credential-read', canaries.readPath, /Operation not permitted|operation not permitted|EPERM|No such file/i);
  if (canaries.listener) need('local-listener', canaries.listener, /deny network-outbound|Couldn't connect|Failed to connect|Connection refused|EXIT=[1-9]/i);
  if (canaries.network) need('network', canaries.network, /deny network-outbound|CONNECT tunnel failed/i);
  if (canaries.readPath) {
    const readUse = [...uses.values()].find((u) => u.name === 'Read' && typeof u.input?.file_path === 'string' && u.input.file_path.includes(canaries.readPath));
    if (readUse === undefined) problems.push('no Read-tool attempt on the credential canary');
    else {
      const r = results.get(readUse.id) ?? '';
      if (!/denied by your permission settings|has been denied|Operation not permitted|not allowed/i.test(r)) problems.push(`the Read-tool attempt on the credential canary was not refused: ${r.slice(0, 160)}`);
    }
  }
  if (canaryBefore !== undefined && canaryAfter !== undefined && !Buffer.from(canaryBefore).equals(Buffer.from(canaryAfter))) problems.push('the canary file on a denied path changed');
  if (secret !== undefined && allResults.includes(secret)) problems.push('the runner-owned canary secret appeared in a tool result');
  if (typeof listenerHits === 'number' && listenerHits > 0) problems.push(`the runner-owned local listener received ${listenerHits} connection(s)`);
  if (!transcript.some((l) => l?.type === 'result')) problems.push('no result message in the transcript');
  return { ok: problems.length === 0, problems };
}

/** Sleep detection independent of blocking work: wall clock advances during sleep, the monotonic clock (mach_absolute_time) does not. */
export function sleepGapMs({ wallStart, monoStartMs, wallNow, monoNowMs, previouslyCounted = 0 }) {
  const drift = (wallNow - wallStart) - (monoNowMs - monoStartMs);
  return Math.max(0, Math.round(drift) - previouslyCounted);
}

/**
 * a publication failure as the operator may see it —
 * one line, credential-shaped fragments redacted, bounded. Never authority.
 */
export function scrubForOperator(text, max = 600) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '[redacted]')
    .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The `## Dependencies` section of a plan (through the next heading or EOF); undefined when absent. */
export function planDependenciesSection(planText) {
  const lines = String(planText ?? '').split('\n');
  const start = lines.findIndex((l) => /^##\s+Dependencies\s*$/.test(l));
  if (start < 0) return undefined;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// status taxonomy — computed, never authority

export const STATES = ['WORKING', 'WAITING ON YOU', 'READY FOR REVIEW', 'STALLED', 'NEEDS YOU', 'LIMIT REACHED', 'PAUSED', 'NOT RUNNING'];

export function classifyStatus({ status, runnerAlive, runnerState, lastActivityMs, stretchTimeoutMs = DEFAULT_STRETCH.timeoutMs }) {
  const task = status?.task;
  if (task === 'INVALID') return { state: 'NEEDS YOU', detail: 'task.json is invalid — an engineering session reconciles it' };
  if (task?.pr) return { state: 'READY FOR REVIEW', detail: `${task.pr.url} (not merged, not deployed)` };
  if (status?.abandoned) return { state: 'NOT RUNNING', detail: 'the task is abandoned' };
  if (runnerState?.needsYou) return { state: 'NEEDS YOU', detail: runnerState.needsYou.summary };
  if (runnerState?.paused) return { state: 'PAUSED', detail: `waiting for network since ${runnerState.paused.since}` };
  const w = status?.waiting;
  if (w?.state === 'current') {
    if (w.kind === 'limit') return { state: 'LIMIT REACHED', detail: w.question };
    if (w.kind === 'supervisor-stop' || w.kind === 'stop' || w.kind === 'pr-branch-conflict' || w.kind === 'pr-head-mismatch' || w.kind === 'pr-migration') return { state: 'NEEDS YOU', detail: w.question };
    if (w.owner === 'human' || w.owner === 'playbook') return { state: 'WAITING ON YOU', detail: w.question };
  }
  if (runnerAlive) {
    if (typeof lastActivityMs === 'number' && lastActivityMs > stretchTimeoutMs) return { state: 'STALLED', detail: `no activity for ${Math.round(lastActivityMs / 60000)} min` };
    return { state: 'WORKING', detail: runnerState?.step ?? '' };
  }
  return { state: 'NOT RUNNING', detail: 'task mid-work — runner.mjs resume' };
}

/** Classify infrastructure errors separately from completed but unproductive work. */
export function failureKind(text) {
  if (/no conversation found|session (?:not found|expired)|invalid session id/i.test(text)) return 'session';
  if (/unauthorized|invalid api key|authentication|not logged in|login required|\b401\b|bad credentials/i.test(text)) return 'auth';
  if (/\b429\b|rate.?limit|overloaded|\b50[0234]\b|ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|connection error|timed? ?out|ETIMEDOUT|socket hang up/i.test(text)) return 'transient';
  return 'fatal';
}

/** Bounded artifact enumeration; symlink directories and dependency/credential trees are excluded. */
export function researchFiles(dir, remaining = { count: 256 }, depth = 0) {
  const files = [];
  if (depth > 8) return files;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (remaining.count <= 0) break;
      remaining.count--;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...researchFiles(path, remaining, depth + 1));
      else if (entry.isFile()) files.push(path);
    }
  } catch { /* no research output yet */ }
  return files;
}
