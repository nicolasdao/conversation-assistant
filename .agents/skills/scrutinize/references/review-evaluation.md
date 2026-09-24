# Maintainer evaluation

Use when changing this skill, not during an ordinary review. These cases are synthetic examples of review failures and valid alternatives. Their policy names, versions and dates are fixtures, not claims about real laws, products or businesses. Do not import confidential artifacts or client details into a published skill package.

## Procedure

1. Give a fresh read-only evaluator the revised SKILL.md, expanded-review reference and [case inputs](../assets/review-cases.json). Withhold [expected outcomes](../assets/review-expectations.json), author explanations and previous results until its first report is complete.
2. Treat the numbered source statements in each fixture as the authoritative evidence for that case. No network access or real-world extrapolation is needed. The inputs simulate the lead's just-edited work; the evaluator performs the cold-reader role.
3. Request a structured result for each case: ID, supported issue IDs, rejected candidates, unresolved items, affected artifact locations, proposed correction and verification limits. Require source-statement IDs as evidence.
4. Compare the report with the expected outcomes. Evaluate meaning, not exact replacement phrases. The oracle specifies minimum observations and prohibited conclusions, not a single allowed rewrite. A partially correct answer fails any criterion it omits.
5. Check corrected uses and dependent conclusions, then challenge false-positive candidates. If the workflow misses a case, fix the relevant instruction and replay the affected cases. Rerun the full set when a shared rule changes. Structural link/JSON checks do not replace this semantic evaluation.
6. Record the skill version, evaluator setup, case outcomes and limitations. A successful small fixture set checks workflow behavior; it does not establish real-world legal accuracy or guarantee detection of every error.

For a stronger comparison, use fresh evaluators on old and revised versions with the same inputs. Keep author reasoning and oracle answers withheld from both; report differences honestly, including cases where the existing skill already succeeds. Repeat or vary cases before claiming a measured improvement. Do not publish confidential evaluator transcripts as fixtures.

The fixtures cover propagation, applicability, draft/current distinctions, evidence gaps, legitimate review prompts, mechanical-check limits, recommendation overreach and unchanged/untracked consumers. They deliberately include both material errors and cases that should remain unchanged.

## Acceptance record — 0.2.0, 12 September 2026

A fresh read-only evaluator received only SKILL.md, expanded-review.md and the case inputs, without the oracle or author explanations. Semantic comparison with the separate expectations passed all eight cases (C01–C08), including the valid prompt in C05 and the unresolved applicability in C06. A different reader compared the skill update with its prior version and found no substantiated instruction defect. HappySkills validation passed all 26 package checks without warnings.

This evaluated cold-reader finding quality, qualification and proposed propagation. It did not execute the complete multi-agent orchestration, actual corrections or post-mutation tests, and no old-versus-new controlled comparison was performed. The results do not establish measured superiority, legal accuracy or complete error detection.
