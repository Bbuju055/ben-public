import { z } from 'zod';

export const verificationSchema = z.object({
  method: z.enum(['test', 'command', 'e2e', 'manual']),
  command: z.string().optional(),
  expect: z.string().optional(),
  artifacts: z.string().optional(),
});

export const criterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  verification: verificationSchema,
});

export const criteriaDocSchema = z.object({
  taskId: z.string().min(1),
  criteria: z.array(criterionSchema).min(1),
  outOfScope: z.array(z.string()).optional(),
});

/** What the planner must return: plan text, files it expects to touch, and the criteria contract. */
export const planOutputSchema = z.object({
  /** short imperative PR title, <= 72 chars */
  title: z.string().min(1).max(72),
  /** plain-English what+why, readable without opening the diff */
  summary: z.string().min(1),
  plan: z.string().min(1),
  files: z.array(z.string()),
  criteria: criteriaDocSchema,
  /** greenfield only: the declared toolchain — gate name -> shell command. Ignored for existing repos. */
  gates: z.record(z.string(), z.string().refine((cmd) => cmd.trim().length > 0, 'gate command must not be blank')).optional(),
});

// --- adversarial review ---

export const blockerSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['BLOCKER', 'MAJOR', 'NIT']),
  claim: z.string().min(1),
  /** file:line or a concrete failure scenario — empty means the blocker is auto-dropped */
  evidence: z.string().optional(),
  /** what would prove the blocker wrong — empty means auto-dropped */
  falsifier: z.string().optional(),
  criterionRef: z.string().optional(),
  /** fingerprint of a previously rejected blocker this one explicitly contests */
  respondsTo: z.string().optional(),
});

export const verdictSchema = z.object({
  verdict: z.enum(['GO', 'NO_GO']),
  blockers: z.array(blockerSchema).default([]),
  notes: z.string().optional(),
});

/** One reconciliation decision per surviving blocker, keyed by its fingerprint. */
export const resolutionSchema = z.object({
  fingerprint: z.string().min(1),
  action: z.enum(['resolved', 'rejected', 'deferred']),
  detail: z.string().min(1),
});

/** RECONCILE_PLAN output: the full revised plan artifact set plus a decision per blocker. */
export const reconcilePlanOutputSchema = planOutputSchema.extend({
  resolutions: z.array(resolutionSchema),
});

/** RECONCILE_DIFF output: decisions only — fixes arrive as commits, not JSON. */
export const reconcileDiffOutputSchema = z.object({
  resolutions: z.array(resolutionSchema),
});

export type Verification = z.infer<typeof verificationSchema>;
export type Criterion = z.infer<typeof criterionSchema>;
export type CriteriaDoc = z.infer<typeof criteriaDocSchema>;
export type PlanOutput = z.infer<typeof planOutputSchema>;
export type Blocker = z.infer<typeof blockerSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
