#!/usr/bin/env node
// Stub `gh` for runner tests: a JSON store (BEN_STUB_GH_STORE) of pull requests
// for a local bare remote (BEN_STUB_REMOTE). Supports exactly what runner.mjs calls.
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const storePath = process.env.BEN_STUB_GH_STORE;
const remote = process.env.BEN_STUB_REMOTE;
const store = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { prs: [], next: 1 });
const save = (s) => writeFileSync(storePath, JSON.stringify(s, null, 2));
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (process.env.BEN_STUB_GH_LOG) appendFileSync(process.env.BEN_STUB_GH_LOG, `${argv.join(' ')}\n`);
const offline = process.env.BEN_STUB_OFFLINE_FILE && existsSync(process.env.BEN_STUB_OFFLINE_FILE);
const [cmd, sub] = argv;
if (cmd === 'api' && process.env.BEN_STUB_CI_FIXTURE && argv.includes('GET')) {
  const path = argv.at(-1);
  const responses = JSON.parse(readFileSync(process.env.BEN_STUB_CI_FIXTURE, 'utf8'));
  const response = responses[path];
  if (response === undefined || response.error) {
    console.error(response?.error ?? `missing CI fixture: ${path}`);
    process.exit(1);
  }
  console.log(JSON.stringify(response));
  process.exit(0);
}
const inspectionFailure = process.env.BEN_STUB_INSPECTION_FAILURE;
if (cmd === 'pr' && sub === 'list' && inspectionFailure && existsSync(inspectionFailure)) {
  const left = Number(readFileSync(inspectionFailure, 'utf8'));
  if (left > 0) {
    writeFileSync(inspectionFailure, String(left - 1));
    console.error('HTTP 503 temporary inspection failure');
    process.exit(1);
  }
}
const branchSha = (branch) => {
  const r = spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const view = (pr) => ({ url: pr.url, body: pr.body, headRefOid: branchSha(pr.head) ?? pr.headRefOid, updatedAt: pr.updatedAt, number: pr.number, state: pr.state, mergedAt: pr.mergedAt ?? null, baseRefName: pr.base, headRefName: pr.head, comments: [{ author: { login: 'operator' }, body: 'looks good, one nit' }] });

if (cmd === 'auth' && sub === 'status') {
  console.log('github.com\n  ✓ Logged in to github.com account tester (keyring)');
  process.exit(0);
}
if (cmd === 'api' && sub === 'rate_limit') {
  if (offline) {
    // the marker holds the number of offline reports left; the network "returns" when it runs out
    const left = Number(readFileSync(process.env.BEN_STUB_OFFLINE_FILE, 'utf8').trim() || '1') - 1;
    if (left <= 0) unlinkSync(process.env.BEN_STUB_OFFLINE_FILE);
    else writeFileSync(process.env.BEN_STUB_OFFLINE_FILE, String(left));
    process.exit(1);
  }
  process.exit(0);
}
if (cmd === 'api' && sub === 'graphql') {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: true, path: 'a', line: 1, comments: { nodes: [{ author: { login: 'r' }, body: 'resolved one' }] } }, { isResolved: false, path: 'math.ts', line: 3, comments: { nodes: [{ author: { login: 'reviewer' }, body: 'rename this' }] } }] } } } } }));
  process.exit(0);
}
if (cmd === 'api' && /^repos\/.*\/comments$/.test(sub)) {
  console.log(JSON.stringify([{ user: { login: 'operator' }, body: 'looks good, one nit' }]));
  process.exit(0);
}
if (cmd === 'repo' && sub === 'view') {
  console.log('main');
  process.exit(0);
}
if (offline) {
  console.error('error connecting to api.github.com');
  process.exit(1);
}
if (cmd === 'pr' && sub === 'list') {
  const head = opt('--head');
  const s = store();
  console.log(JSON.stringify(s.prs.filter((p) => p.head === head).map((p) => ({ number: p.number, url: p.url, headRefOid: branchSha(p.head) ?? p.headRefOid, state: p.state, mergedAt: p.mergedAt ?? null }))));
  process.exit(0);
}
if (cmd === 'pr' && sub === 'create') {
  const s = store();
  const head = opt('--head');
  const sha = branchSha(head);
  if (!sha) {
    console.error(`head branch ${head} does not exist on the remote`);
    process.exit(1);
  }
  if (s.prs.some((p) => p.head === head && p.state === 'OPEN')) {
    console.error(`a pull request for branch "${head}" already exists`);
    process.exit(1);
  }
  // GitHub's real limit: titles over 256 characters are refused
  if (String(opt('--title') ?? '').length > 256) {
    console.error('pull request create failed: GraphQL: Title is too long (maximum is 256 characters) (createPullRequest)');
    process.exit(1);
  }
  // seam: fail exactly once (the marker file is consumed) with credential-shaped noise in the message
  if (process.env.BEN_STUB_GH_FAIL_CREATE_FILE && existsSync(process.env.BEN_STUB_GH_FAIL_CREATE_FILE)) {
    unlinkSync(process.env.BEN_STUB_GH_FAIL_CREATE_FILE);
    console.error('pull request create failed: HTTP 502 from https://api.github.com/graphql\n  (token ghp_STUBTOKEN00000000000000 rejected; Bearer ghs_STUBBEARER0000000000)');
    process.exit(1);
  }
  const pr = { number: s.next, url: `https://github.com/${opt('--repo')}/pull/${s.next}`, head, base: opt('--base'), title: opt('--title'), body: readFileSync(opt('--body-file'), 'utf8'), headRefOid: sha, state: 'OPEN', updatedAt: new Date().toISOString() };
  s.next += 1;
  s.prs.push(pr);
  save(s);
  console.log(pr.url);
  process.exit(0);
}
if (cmd === 'pr' && (sub === 'view' || sub === 'edit' || sub === 'reopen')) {
  const url = argv[2];
  // seam: the view AFTER a successful create fails exactly once (publication
  // succeeded remotely, local recording did not)
  if (sub === 'view' && process.env.BEN_STUB_GH_FAIL_VIEW_FILE && existsSync(process.env.BEN_STUB_GH_FAIL_VIEW_FILE)) {
    unlinkSync(process.env.BEN_STUB_GH_FAIL_VIEW_FILE);
    console.error('HTTP 500: Internal Server Error (https://api.github.com/graphql)');
    process.exit(1);
  }
  const s = store();
  const pr = s.prs.find((p) => p.url === url || String(p.number) === url);
  if (!pr) {
    console.error(`no pull request found for ${url}`);
    process.exit(1);
  }
  if (sub === 'edit') {
    pr.body = readFileSync(opt('--body-file'), 'utf8');
    pr.updatedAt = new Date().toISOString();
    save(s);
    process.exit(0);
  }
  if (sub === 'reopen') {
    pr.state = 'OPEN';
    save(s);
    process.exit(0);
  }
  console.log(JSON.stringify(view(pr)));
  process.exit(0);
}
console.error(`stub gh: unsupported ${argv.join(' ')}`);
process.exit(64);
