import { beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runTask, type PrResult } from '../src/orchestrator/machine';
import { loadState, saveState, taskDir } from '../src/orchestrator/state';
import { prBody } from '../src/github/pr';
import { fingerprintBlocker, readLedger } from '../src/ledger/ledger';
import {
  approveGate,
  blockerOf,
  commitChange,
  FakeAdapter,
  FakeReviewer,
  makeFixtureRepo,
  planParsed,
  startTask,
  testConfig,
  useTmpHome,
  verdictParsed,
} from './helpers';
import type { BenConfig } from '../src/config';

const C_TEST = {
  id: 'C1',
  statement: 'unit tests pass',
  verification: { method: 'test', command: 'bun test math.test.ts', expect: 'exit 0' },
};

function prSpy() {
  const calls: PrResult[] = [];
  return {
    calls,
    createPr: async (): Promise<PrResult> => {
      const pr = { number: 1, url: 'https://example.test/pr/1', headSha: 'deadbeef' };
      calls.push(pr);
      return pr;
    },
  };
}

function panelCfg(panel: Partial<BenConfig['panel']>, overrides: Partial<BenConfig> = {}): BenConfig {
  return testConfig({ panel: { plan: [], diff: [], tieBreak: 'unanimous-go', ...panel }, ...overrides });
}

function fp(blocker: Record<string, unknown>): string {
  return fingerprintBlocker(blocker as { criterionRef?: string; evidence?: string; claim: string });
}

function resolutions(...items: Array<{ fingerprint: string; action: string; detail?: string }>): unknown[] {
  return items.map((r) => ({ detail: r.detail ?? 'handled', ...r }));
}

beforeEach(async () => {
  await useTmpHome();
});

test('plan blocker: NO_GO → reconcile → GO lands at the approval gate with the panel-hardened plan', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2plan', repo);
  const blocker = blockerOf();
  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed('m2plan', [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      // reconcile: full revised plan + a decision per fingerprint
      return { parsed: { ...base, plan: '# plan\n\nrevision 2', resolutions: resolutions({ fingerprint: fp(blocker), action: 'resolved' }) } };
    },
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [blocker]), verdictParsed('GO')]);
  const cfg = panelCfg({ plan: ['rev'] });
  const pr = prSpy();
  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };

  const paused = await runTask('m2plan', cfg, deps);

  // the gate lands after RECONCILE_PLAN: both review rounds already happened, nothing built
  expect(paused.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(reviewer.calls.length).toBe(2);
  expect(paused.rounds.plan).toBe(1);
  expect(fake.implementCalls).toBe(0);

  const ledger = await readLedger('m2plan');
  expect(ledger.map((e) => e.action)).toEqual(['raised', 'resolved']);
  expect(ledger[0]?.fingerprint).toBe(fp(blocker));
  // round 2 reviewer saw the ledger, not a blank slate
  expect(reviewer.calls[1]?.prompt).toContain(fp(blocker));

  await approveGate('m2plan');
  const final = await runTask('m2plan', cfg, deps); // "ben approve" then build
  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
});

test('a rejected blocker cannot be re-raised by paraphrase', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2reject', repo);
  const original = blockerOf();
  const paraphrase = blockerOf({
    id: 'B7',
    claim: 'zero-argument addition remains unverified by any criterion',
    evidence: 'see math.ts — nothing exercises the zero case',
  });
  expect(fp(paraphrase)).toBe(fp(original)); // same criterion + same file = same identity

  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed('m2reject', [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      return { parsed: { ...base, resolutions: resolutions({ fingerprint: fp(original), action: 'rejected', detail: 'zero case is covered by C1' }) } };
    },
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [original]), verdictParsed('NO_GO', [paraphrase])]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2reject', panelCfg({ plan: ['rev'] }), deps);
  await approveGate('m2reject');
  const final = await runTask('m2reject', panelCfg({ plan: ['rev'] }), deps);

  // the paraphrased re-raise was mechanically dropped, so round 2 gates nothing
  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
  const actions = (await readLedger('m2reject')).map((e) => e.action);
  expect(actions).toEqual(['raised', 'rejected', 're-raise-dropped']);
});

test('a blocker without a falsifier is auto-dropped and never reaches reconciliation', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2drop', repo);
  const vague = blockerOf({ falsifier: '' });
  let committed = false;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2drop', [C_TEST]) }),
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [vague])]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2drop', panelCfg({ plan: ['rev'] }), deps);
  await approveGate('m2drop');
  const final = await runTask('m2drop', panelCfg({ plan: ['rev'] }), deps);

  expect(final.phase).toBe('DONE');
  expect(fake.planCalls).toBe(1); // no reconcile round ever ran
  expect(final.rounds.plan).toBe(0); // an unfalsifiable blocker costs no round
  expect((await readLedger('m2drop')).map((e) => e.action)).toEqual(['auto-dropped']);
});

test('unanimous-go: GO plus ABSTAIN with no blockers escalates', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2abstain', repo);
  const fake = new FakeAdapter(() => ({ parsed: planParsed('m2abstain', [C_TEST]) }), () => ({}));
  const goReviewer = new FakeReviewer('revA', [verdictParsed('GO')]);
  const brokenReviewer = new FakeReviewer('revB', [{ parsed: undefined, raw: 'not json at all' }]);
  const pr = prSpy();

  const final = await runTask(
    'm2abstain',
    panelCfg({ plan: ['revA', 'revB'] }),
    { adapters: { fake, revA: goReviewer, revB: brokenReviewer }, createPr: pr.createPr },
  );

  expect(final.phase).toBe('ESCALATED');
  expect(final.lastError).toContain('unanimous-go violated');
  expect(brokenReviewer.calls.length).toBe(2); // one retry before ABSTAIN
  expect(pr.calls.length).toBe(0);
  expect((await readLedger('m2abstain')).map((e) => e.action)).toEqual(['abstain']);
});

test('BLOCKER + ABSTAIN in one round: the blocker dominates — reconcile proceeds, the abstain is recorded', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2mixed', repo);
  const b1 = blockerOf({ evidence: 'src/a.ts misses the retry path' });
  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed('m2mixed', [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      return { parsed: { ...base, plan: '# plan\n\nrevision 2', resolutions: resolutions({ fingerprint: fp(b1), action: 'resolved' }) } };
    },
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const blocking = new FakeReviewer('revA', [verdictParsed('NO_GO', [b1]), verdictParsed('GO')]);
  const broken = new FakeReviewer('revB', [{ parsed: undefined, raw: 'garbage' }, { parsed: undefined, raw: 'garbage' }, verdictParsed('GO')]);
  const pr = prSpy();

  const deps = { adapters: { fake, revA: blocking, revB: broken }, createPr: pr.createPr };
  await runTask('m2mixed', panelCfg({ plan: ['revA', 'revB'] }), deps);
  await approveGate('m2mixed');
  const final = await runTask('m2mixed', panelCfg({ plan: ['revA', 'revB'] }), deps);

  // round 1: revA blocker + revB abstain → reconcile (not escalation); round 2: both GO → proceed
  expect(final.phase).toBe('DONE');
  expect(final.rounds.plan).toBe(1);
  expect(broken.calls.length).toBe(3); // round 1: two parse attempts → abstain; round 2: one clean GO
  const actions = (await readLedger('m2mixed')).map((e) => e.action);
  expect(actions).toEqual(['raised', 'abstain', 'resolved']);
  expect(pr.calls.length).toBe(1);
});

test('plan budget, full-round semantics: rounds 1-3 each get their reconcile, the 4th lands at the gate exhausted', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2budget', repo);
  const blockers = [1, 2, 3, 4].map((n) =>
    blockerOf({ id: `B${n}`, claim: `defect number ${n}`, evidence: `src/file${n}.ts misses case ${n}` }),
  );
  let planCall = 0;
  const fake = new FakeAdapter(() => {
    planCall += 1;
    const base = planParsed('m2budget', [C_TEST]) as Record<string, unknown>;
    if (planCall === 1) return { parsed: base };
    // reconcile N resolves blocker N (planCall 2 → blocker 1, etc.)
    return { parsed: { ...base, plan: `# plan\n\nrevision ${planCall}`, resolutions: resolutions({ fingerprint: fp(blockers[planCall - 2]!), action: 'resolved' }) } };
  }, () => ({}));
  const reviewer = new FakeReviewer('rev', blockers.map((b) => verdictParsed('NO_GO', [b])));
  const pr = prSpy();

  const final = await runTask('m2budget', panelCfg({ plan: ['rev'] }), { adapters: { fake, rev: reviewer }, createPr: pr.createPr });

  // exhaustion never throws the hardened plan away: it waits at the gate with the blockers on display
  expect(final.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(final.planReviewExhausted).toBe(true);
  expect(final.lastError).toBeUndefined();
  expect(reviewer.calls.length).toBe(4); // reviews 1-3 reconciled, review 4 denied
  expect(fake.planCalls).toBe(4); // 1 plan + 3 reconciles — the final allowed round got its reconcile
  expect(final.rounds.plan).toBe(4);
  // every allowed round completed its full raised→resolved cycle before the denied 4th raise
  expect((await readLedger('m2budget')).map((e) => e.action)).toEqual([
    'raised', 'resolved', 'raised', 'resolved', 'raised', 'resolved', 'raised',
  ]);
  expect(pr.calls.length).toBe(0);
  expect(fake.implementCalls).toBe(0); // nothing builds without a recorded approval
});

test('plan budget is shared: a pregate bounce leaves two reconciled review rounds, then the gate', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2cap', repo);
  const badCriterion = { id: 'C9', statement: 'broken', verification: { method: 'command' } }; // no command → pregate bounce
  const b1 = blockerOf({ evidence: 'src/a.ts misses the retry path' });
  const b2 = blockerOf({ id: 'B2', claim: 'timeout untested', evidence: 'src/b.ts has no timeout test' });
  const b3 = blockerOf({ id: 'B3', claim: 'cancel untested', evidence: 'src/c.ts has no cancel test' });
  let planCall = 0;
  const fake = new FakeAdapter(() => {
    planCall += 1;
    const base = planParsed('m2cap', [C_TEST]) as Record<string, unknown>;
    if (planCall === 1) return { parsed: planParsed('m2cap', [C_TEST, badCriterion]) };
    if (planCall === 2) return { parsed: base }; // pregate-clean plan
    if (planCall === 3) return { parsed: { ...base, plan: '# plan\n\nrevision 3', resolutions: resolutions({ fingerprint: fp(b1), action: 'resolved' }) } };
    return { parsed: { ...base, plan: `# plan\n\nrevision ${planCall}`, resolutions: resolutions({ fingerprint: fp(b2), action: 'resolved' }) } };
  }, () => ({}));
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [b1]), verdictParsed('NO_GO', [b2]), verdictParsed('NO_GO', [b3])]);
  const pr = prSpy();

  const final = await runTask('m2cap', panelCfg({ plan: ['rev'] }), { adapters: { fake, rev: reviewer }, createPr: pr.createPr });

  // budget of 3: pregate bounce  + reconciled review  + reconciled review; the next review exceeds it
  expect(final.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(final.planReviewExhausted).toBe(true);
  expect(final.rounds.plan).toBe(4);
  expect(reviewer.calls.length).toBe(3); // the pregate bounce cost one review round — explicit, not hidden
  expect(fake.planCalls).toBe(4); // plan + replan + 2 reconciles
  expect(pr.calls.length).toBe(0);
});

test('diff budget has identical full-round semantics: three reconciled rounds, the fourth escalates', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2diffcap', repo);
  const blockers = [1, 2, 3, 4].map((n) =>
    blockerOf({ id: `D${n}`, claim: `diff defect ${n}`, evidence: `src/file${n}.ts breaks case ${n}` }),
  );
  let implementCall = 0;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2diffcap', [C_TEST]) }),
    async (input) => {
      implementCall += 1;
      if (implementCall === 1) {
        await commitChange(input.cwd, 'impl');
        return {};
      }
      // every reconcile rejects (no commit) → straight back to review, no gates loop
      return {
        parsed: {
          resolutions: resolutions({ fingerprint: fp(blockers[implementCall - 2]!), action: 'rejected', detail: 'not a defect' }),
        },
      };
    },
  );
  const reviewer = new FakeReviewer('rev', blockers.map((b) => verdictParsed('NO_GO', [b])));
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2diffcap', panelCfg({ diff: ['rev'] }), deps);
  await approveGate('m2diffcap');
  const final = await runTask('m2diffcap', panelCfg({ diff: ['rev'] }), deps);

  expect(final.phase).toBe('ESCALATED'); // diff exhaustion still escalates — the human gate guards the PLAN
  expect(reviewer.calls.length).toBe(4); // rounds 1-3 reconciled, round 4 denied
  expect(fake.implementCalls).toBe(4); // 1 implement + 3 reconciles — the final allowed round got its reconcile
  expect(final.rounds.diff).toBe(4);
  expect(final.lastError).toContain('diff rounds exhausted (3/3 consumed');
  expect(pr.calls.length).toBe(0);
});

test('diff loop: a committed fix re-runs gates; a rejection-only round skips straight back to review', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2diff', repo);
  const d1 = blockerOf({ id: 'D1', claim: 'fix needed', evidence: 'impl.md is wrong' });
  const d2 = blockerOf({ id: 'D2', claim: 'style objection', evidence: 'fix.md could be nicer' });
  let implementCall = 0;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2diff', [C_TEST]) }),
    async (input) => {
      implementCall += 1;
      if (implementCall === 1) {
        await commitChange(input.cwd, 'impl');
        return {};
      }
      if (implementCall === 2) {
        // reconcile round 1: commit the fix → HEAD moves → gates must re-run
        await commitChange(input.cwd, 'fix');
        return { parsed: { resolutions: resolutions({ fingerprint: fp(d1), action: 'resolved' }) } };
      }
      // reconcile round 2: rejection only → HEAD identical → straight back to review
      return { parsed: { resolutions: resolutions({ fingerprint: fp(d2), action: 'rejected', detail: 'style is not a defect' }) } };
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [d1]), verdictParsed('NO_GO', [d2]), verdictParsed('GO')]);
  const pr = prSpy();
  const cfg = panelCfg({ diff: ['rev'] }, { gates: { test: 'bun test math.test.ts', mark: 'echo run >> gates-ran.txt' } });

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2diff', cfg, deps);
  await approveGate('m2diff');
  const final = await runTask('m2diff', cfg, deps);

  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
  expect(final.rounds.diff).toBe(2);
  expect(reviewer.calls.length).toBe(3);
  // gates ran exactly twice: initial pass + after the committed fix; never after the rejection-only round
  const marks = (await readFile(join(final.worktreePath, 'gates-ran.txt'), 'utf8')).trim().split('\n');
  expect(marks.length).toBe(2);
  const actions = (await readLedger('m2diff')).map((e) => e.action);
  expect(actions).toEqual(['raised', 'resolved', 'raised', 'rejected']);
});

test('a MAJOR finding never gates: the run reaches DONE and the note lands in the PR body', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2major', repo);
  const major = blockerOf({ severity: 'MAJOR', claim: 'naming could be tighter', evidence: 'impl.md reads awkwardly' });
  let committed = false;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2major', [C_TEST]) }),
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('GO', [major])]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2major', panelCfg({ plan: ['rev'], diff: ['rev'] }), deps);
  await approveGate('m2major');
  const final = await runTask('m2major', panelCfg({ plan: ['rev'], diff: ['rev'] }), deps);

  expect(final.phase).toBe('DONE'); // MAJOR gates nothing
  expect(pr.calls.length).toBe(1);
  expect(final.rounds.plan).toBe(0);
  expect(final.rounds.diff).toBe(0);
  expect(await readLedger('m2major')).toEqual([]); // non-gating findings never enter the ledger

  const body = await prBody(final);
  expect(body).toContain('## Review notes — non-blocking');
  expect(body).toContain('**MAJOR** (rev, plan review round 1): naming could be tighter — impl.md reads awkwardly');
});

// --- calibration lock: what gates, what merely notes, and how rejection stands its ground ---

test('a real evidence-backed model mismatch still gates the plan', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2mismatch', repo);
  const mismatch = blockerOf({
    claim: 'the plan says every record carries a revision number, but the model gives one only to documents',
    evidence: 'src/domain/record.ts:19 — revision exists on documentSchema alone',
    falsifier: 'point to a revision field on any non-document schema',
  });
  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed('m2mismatch', [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      return { parsed: { ...base, plan: '# plan\n\nreworded to match the code', resolutions: resolutions({ fingerprint: fp(mismatch), action: 'resolved', detail: 'plan reworded to match the code' }) } };
    },
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [mismatch]), verdictParsed('GO')]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2mismatch', panelCfg({ plan: ['rev'] }), deps);
  await approveGate('m2mismatch');
  const final = await runTask('m2mismatch', panelCfg({ plan: ['rev'] }), deps);

  expect(final.phase).toBe('DONE');
  expect(final.rounds.plan).toBe(1); // it gated: a round was consumed reconciling it
  expect((await readLedger('m2mismatch')).map((e) => e.action)).toEqual(['raised', 'resolved']);
});

test('an impossible "mechanically prove prose meaning" demand recorded as MAJOR never gates', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2prose', repo);
  const impossible = blockerOf({
    severity: 'MAJOR',
    claim: 'C12 cannot prove the guide semantically explains when to use each storage format',
    evidence: 'criteria.json C12 — grep for fixed phrases accepts a document stating the opposite',
    falsifier: 'a mechanical check that verifies the meaning of the prose',
  });
  let committed = false;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2prose', [C_TEST]) }),
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  // NO_GO carrying only a MAJOR: the machine gates on surviving BLOCKERs, not on the verdict word
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [impossible])]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2prose', panelCfg({ plan: ['rev'] }), deps);
  await approveGate('m2prose');
  const final = await runTask('m2prose', panelCfg({ plan: ['rev'] }), deps);

  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
  expect(final.rounds.plan).toBe(0); // cost no round
  expect(fake.planCalls).toBe(1); // no reconcile ever ran
  expect(await readLedger('m2prose')).toEqual([]); // never entered the ledger
  expect(await prBody(final)).toContain('**MAJOR** (rev, plan review round 1): C12 cannot prove the guide semantically explains');
});

test('planner rejects an impossible-falsifier BLOCKER; only respondsTo can legitimately contest it', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2contest', repo);
  const impossible = blockerOf({
    claim: 'the criteria cannot prove the document means what it says',
    evidence: 'criteria.json C5 — fixed-string greps accept a negated differentiator',
    falsifier: 'a grep that proves prose semantics',
  });
  const contest = blockerOf({
    id: 'B9',
    claim: 'the rejection ignores that C5 accepts explicit negations of every differentiator',
    evidence: 'criteria.json C5 — fixed-string greps accept a negated differentiator',
    falsifier: 'a grep that proves prose semantics',
    respondsTo: fp(impossible), // explicit contest — the one legitimate way back in
  });
  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed('m2contest', [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      if (planCall === 2) {
        // rejection-only reconcile: the plan may legitimately stay unchanged
        return { parsed: { ...base, resolutions: resolutions({ fingerprint: fp(impossible), action: 'rejected', detail: 'grep proves structure, not semantics — the human at the review pause owns meaning' }) } };
      }
      return { parsed: { ...base, plan: '# plan\n\ntightened C5', resolutions: resolutions({ fingerprint: fp(contest), action: 'resolved', detail: 'tightened C5 to require the affirmative sentences' }) } };
    },
    async (input) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  const reviewer = new FakeReviewer('rev', [
    verdictParsed('NO_GO', [impossible]),
    verdictParsed('NO_GO', [contest]),
    verdictParsed('GO'),
  ]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2contest', panelCfg({ plan: ['rev'] }), deps);
  await approveGate('m2contest');
  const final = await runTask('m2contest', panelCfg({ plan: ['rev'] }), deps);

  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
  // contest carried the same fingerprint but respondsTo let it through — it gated round 2
  expect(final.rounds.plan).toBe(2);
  expect((await readLedger('m2contest')).map((e) => e.action)).toEqual(['raised', 'rejected', 'raised', 'resolved']);
});

test('challenge and reconcile prompts carry the proof-boundary and materiality calibration', async () => {
  const promptsDir = join(import.meta.dir, '../prompts');
  for (const name of ['challenge-plan.md', 'challenge-diff.md']) {
    const text = await readFile(join(promptsDir, name), 'utf8');
    expect(text).toContain('CANNOT prove the semantic meaning of prose');
    expect(text).toContain('record it as MAJOR');
    expect(text).toContain('IS a legitimate BLOCKER');
    expect(text).toContain('MATERIAL contract failure');
    expect(text).toContain('GO does not mean perfect. GO means no material defect remains.');
  }
  for (const name of ['reconcile-plan.md', 'reconcile-diff.md']) {
    const text = await readFile(join(promptsDir, name), 'utf8');
    expect(text).toContain('FIRST evaluate its falsifier');
    expect(text).toContain('grounds for rejection');
    expect(text).toContain('Rejection is not the default');
  }
});

// --- human pause on exhausted plan budget, and the plan-side honesty check ---

function exhaustionSetup(taskId: string) {
  const blockers = [1, 2, 3, 4].map((n) =>
    blockerOf({ id: `B${n}`, claim: `defect ${n}`, evidence: `src/file${n}.ts misses case ${n}` }),
  );
  let planCall = 0;
  let committed = false;
  const fake = new FakeAdapter(
    () => {
      planCall += 1;
      const base = planParsed(taskId, [C_TEST]) as Record<string, unknown>;
      if (planCall === 1) return { parsed: base };
      return {
        parsed: {
          ...base,
          plan: `# plan\n\nrevision ${planCall}`,
          resolutions: resolutions({ fingerprint: fp(blockers[planCall - 2]!), action: 'resolved' }),
        },
      };
    },
    async (input: { cwd: string }) => {
      if (!committed) {
        await commitChange(input.cwd, 'impl');
        committed = true;
      }
      return {};
    },
  );
  return { blockers, fake };
}

test('exhausted plan budget waits at the gate — not GO, not ESCALATED, nothing built without approval', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2pause', repo);
  const { blockers, fake } = exhaustionSetup('m2pause');
  const reviewer = new FakeReviewer('rev', blockers.map((b) => verdictParsed('NO_GO', [b])));
  const pr = prSpy();
  const cfg = panelCfg({ plan: ['rev'] });
  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };

  const paused = await runTask('m2pause', cfg, deps);

  expect(paused.phase).toBe('AWAIT_PLAN_APPROVAL'); // waiting at the gate — not ESCALATED
  expect(paused.planReviewExhausted).toBe(true);
  expect(paused.lastError).toBeUndefined();
  expect(fake.implementCalls).toBe(0); // nothing built before the human decision
  expect(pr.calls.length).toBe(0);
  expect(paused.rounds.plan).toBe(4);
  // the unresolved blocker is on disk, clearly identified for the human
  const unresolvedFile = JSON.parse(await readFile(join(taskDir('m2pause'), 'blockers.json'), 'utf8')) as Array<{ claim: string }>;
  expect(unresolvedFile.map((b) => b.claim)).toEqual(['defect 4']);

  // a plain resume WITHOUT approval stays at the gate — override requires the recorded decision
  const still = await runTask('m2pause', cfg, deps);
  expect(still.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(fake.implementCalls).toBe(0);

  // human records APPROVE BUILD (the override): builds and finishes
  await approveGate('m2pause');
  const final = await runTask('m2pause', cfg, deps);
  expect(final.phase).toBe('DONE');
  expect(final.planReviewExhausted).toBe(false); // cleared on the approved handoff
  expect(pr.calls.length).toBe(1);
});

test('after the exhausted pause, a human-requested reconciliation reaches GO and re-pauses cleanly', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2again', repo);
  const { blockers, fake } = exhaustionSetup('m2again');
  // reviews 1-4 raise; the post-reconcile 5th review says GO
  const reviewer = new FakeReviewer('rev', [...blockers.map((b) => verdictParsed('NO_GO', [b])), verdictParsed('GO')]);
  const pr = prSpy();
  const cfg = panelCfg({ plan: ['rev'] });
  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };

  const paused = await runTask('m2again', cfg, deps);
  expect(paused.phase).toBe('AWAIT_PLAN_APPROVAL');
  expect(paused.planReviewExhausted).toBe(true);

  // simulate `ben resume --reconcile`: the human grants one more reconciliation round
  const s = await loadState('m2again');
  s.planApproval = undefined;
  s.phase = 'RECONCILE_PLAN';
  await saveState(s);
  const paused2 = await runTask('m2again', cfg, deps);

  expect(paused2.phase).toBe('AWAIT_PLAN_APPROVAL'); // back at the gate, clean this time
  expect(paused2.planReviewExhausted).toBe(false); // clean GO cleared the pending decision
  expect(paused2.rounds.plan).toBe(4); // a GO round consumes no budget
  expect((await readLedger('m2again')).map((e) => e.action)).toEqual([
    'raised', 'resolved', 'raised', 'resolved', 'raised', 'resolved', 'raised', 'resolved',
  ]);
  expect(fake.implementCalls).toBe(0);

  await approveGate('m2again');
  const final = await runTask('m2again', cfg, deps);
  expect(final.phase).toBe('DONE');
  expect(pr.calls.length).toBe(1);
});

test('plan reconcile claiming "resolved" without changing plan or criteria is bounced, then escalates', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2planliar', repo);
  const b1 = blockerOf({ evidence: 'src/a.ts misses the retry path' });
  let planCall = 0;
  const fake = new FakeAdapter(() => {
    planCall += 1;
    const base = planParsed('m2planliar', [C_TEST]) as Record<string, unknown>;
    if (planCall === 1) return { parsed: base };
    // claims resolved but returns the identical plan and criteria — twice
    return { parsed: { ...base, resolutions: resolutions({ fingerprint: fp(b1), action: 'resolved' }) } };
  }, () => ({}));
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [b1])]);
  const pr = prSpy();

  const final = await runTask('m2planliar', panelCfg({ plan: ['rev'] }), { adapters: { fake, rev: reviewer }, createPr: pr.createPr });

  expect(final.phase).toBe('ESCALATED');
  expect(final.lastError).toContain('reconcile (plan) failed twice');
  expect(final.lastError).toContain('identical to the reviewed version');
  expect(reviewer.calls.length).toBe(1);
  expect(pr.calls.length).toBe(0);
});

test('"resolved" with no commit is bounced, then escalates on the second offense', async () => {
  const repo = await makeFixtureRepo();
  await startTask('m2liar', repo);
  const d1 = blockerOf({ id: 'D1', claim: 'fix needed', evidence: 'impl.md is wrong' });
  let implementCall = 0;
  const fake = new FakeAdapter(
    () => ({ parsed: planParsed('m2liar', [C_TEST]) }),
    async (input) => {
      implementCall += 1;
      if (implementCall === 1) {
        await commitChange(input.cwd, 'impl');
        return {};
      }
      // claims a fix, commits nothing — twice
      return { parsed: { resolutions: resolutions({ fingerprint: fp(d1), action: 'resolved' }) } };
    },
  );
  const reviewer = new FakeReviewer('rev', [verdictParsed('NO_GO', [d1])]);
  const pr = prSpy();

  const deps = { adapters: { fake, rev: reviewer }, createPr: pr.createPr };
  await runTask('m2liar', panelCfg({ diff: ['rev'] }), deps);
  await approveGate('m2liar');
  const final = await runTask('m2liar', panelCfg({ diff: ['rev'] }), deps);

  expect(final.phase).toBe('ESCALATED');
  expect(final.lastError).toContain('reconcile (diff) failed twice');
  expect(final.lastError).toContain('nothing was committed');
  expect(pr.calls.length).toBe(0);
});
