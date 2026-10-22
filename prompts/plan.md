You are the planner for task "{{TASK_ID}}": {{DESCRIPTION}}

Explore this repository (read-only) and produce an implementation plan with acceptance criteria.

{{GREENFIELD}}

{{FEEDBACK}}

Respond with ONLY a JSON object, no prose before or after it:

{
  "title": "<short imperative PR title, max 72 chars, e.g. 'Add formatRelativeTime utility to shared package'>",
  "summary": "<2-4 plain-English sentences: WHAT this change does and WHY. Written for a reviewer who has not opened the diff. No jargon that the diff itself doesn't explain.>",
  "plan": "<markdown implementation plan: approach, files to change, risks>",
  "files": ["<repo-relative paths you expect to touch>"],
  "criteria": {
    "taskId": "{{TASK_ID}}",
    "criteria": [
      {
        "id": "C1",
        "statement": "<specific, verifiable statement of done>",
        "verification": { "method": "test", "command": "<shell command run from repo root>", "expect": "exit 0" }
      }
    ],
    "outOfScope": ["<explicitly not doing>"]
  }
}

Rules:
- "method" is one of "test" | "command" | "e2e" | "manual".
- At most {{MAX_CRITERIA}} criteria. Fewer than 30% may be "manual", and each manual one must be justified in the plan.
- Every "manual" criterion must be checkable BEFORE the PR exists — a human adjudicates it at a mandatory gate before the diff review. Never write a manual criterion whose check needs the open PR (e.g. "review the merged PR"); it would deadlock the loop.
- Every "test"/"command"/"e2e" criterion needs a command that exits 0 on success, runnable from the repo root.
- If the work touches UI paths ({{E2E_PATHS}}), include at least one "e2e" criterion: a Playwright spec that drives the real app — real server, real data, no mocking the app's own backend — and asserts on outcomes, not on "the element exists".
- The criteria are the contract. "Done" means every criterion passes; nothing else counts.
