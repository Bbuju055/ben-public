# Quality bar

ben should make the evidence behind an AI-built change inspectable and keep
consequential decisions with the human operator. This is a design contract;
the operator defines each task's scope and approves its plan.

- Scripts enforce workflow and evidence requirements. Models propose work and
  review its adequacy; their reports alone are not proof.
- Approval binds the plan artifacts and verdict-relevant configuration. A changed
  contract requires renewed approval.
- Unresolved blocking findings stop progress. Human decisions and accepted gaps
  stay on the record.
- Review uses source artifacts and the actual diff. Successful commands do not
  establish that the tests or acceptance criteria are sufficient.
- Resume from durable state; refuse contradictory history rather than invent a
  repair. A parked human decision is never automatically approved.
- Delivery ends at a PR ready for human review. ben never merges or deploys.

See [design](DESIGN.md), [roadmap](ROADMAP.md), and [limitations](FINDINGS.md).
