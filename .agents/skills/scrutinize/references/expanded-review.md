# Expanded review for consequential or complex work

Use this reference when Step 0 selects an expanded review. The core pipeline remains authoritative. Scale effort to the consequences and uncertainty; a large team is not itself evidence of quality.

## 1. Divide the questions before reviewing

Choose two or three independent read-only reviewers, subject to available capacity. Give each a concrete question that can be answered alongside useful work by the lead. For example:

- **Source and applicability:** does the code, rule, contract or dataset support the claim for this actor, version and period?
- **Counterexamples and consistency:** could a valid case fail, an invalid case pass, or a corrected claim remain wrong in another location?
- **Consequences and evidence:** does the finding support the recommendation, cost, ownership assertion or operational decision that follows?

Divide domains when useful, but include a different question in each assignment. Reviewers receive the original request, artifact, diff and relevant source access. Withhold the author's justifications and earlier verdicts until independent first reports arrive. Shared infrastructure or repeated opinions do not constitute independent evidence. If only one reviewer is available, narrow its question and disclose the reduced coverage.

## 2. Maintain one short review record

The lead owns the record. It may live in working notes; create a deliverable only when it benefits the task or the user requests one. Track material claims and behaviors, not every sentence.

| Item | Required detail |
|---|---|
| Subject | Specific claim, behavior or decision and consequence if wrong |
| Evidence | Primary source/test, version or effective period, exact locator and access limitations |
| Applicability | Actor, object/cohort, trigger, conditions, exceptions and alternatives |
| Affected uses | Original location, equivalent statements, consumers and dependent decisions |
| Review | Assigned question/reviewer, contrary evidence and counterexample result |
| Status | Core Step 0 status, remaining evidence and verification result |

Separate the claim's truth from evidence of the target's actual condition. A correct legal requirement does not establish that a business breaches it; a historical service banner does not establish a current vulnerability. Conversely, an unknown is not proof of compliance.

## 3. Test the boundary, not only the example

For each material rule or assertion, resolve the relevant dimensions:

- **Actor and role:** provider, vendor, operator, user, processor, holder or contracting party.
- **Object and cohort:** record class, product edition, material type, legacy/current cohort or transaction type.
- **Version and status:** applicable release/commit; operative, repealed, draft or announced requirement. The latest source may not apply to a historical period or installed version.
- **Clock:** triggering event, start/end, timezone or business/calendar days where relevant. Audit date, report receipt and awareness are different events.
- **Conditions and alternatives:** thresholds, conjunctions, exceptions, approvals, transitions and permitted manual/integrated implementations.
- **Inference:** what observation is established, what remains a hypothesis, and whether it supports the proposed consequence.

Construct both a legitimate case the artifact might reject and a prohibited/failing case it might accept. Use primary evidence or executable behavior to decide; an imagined counterexample alone is not proof. For factual rules, online summaries and current links still require clause, version and applicability checks. If access fails, retain that limitation rather than silently relying on memory.

## 4. Reconcile, then verify with a different reader

After independent first reports, exchange the strongest findings and disagreements. Ask the challenger to try to disprove each material finding using the source, alternative controls and surrounding context. Distinguish a request for further evidence from an assertion of failure. Record supported findings, rejected candidates and unresolved evidence separately; do not fix by vote.

The lead applies proven corrections under the core pipeline. Search all affected uses, including shorthand, synonymous wording, repeated numbers and decisions whose premise changed. In code, include callers, schemas and examples; in analyses, include matrices, checklists, costs and recommendations. Keep preserved original evidence separate from reviewed guidance.

For material fixes, assign a reviewer who did not author the correction to inspect the final wording or behavior against the source and affected uses. Where useful, swap domains between reviewers. This final pass checks the changes themselves; it does not restart an unlimited audit. A new proven issue reopens only the affected work and checks.

## 5. Report the evidence boundary

Use the core stopping criteria. Distinguish:

- substantive correctness established by primary evidence or behavioral tests;
- consistency established by propagation, structure, link/hash or wording checks;
- material unresolved evidence, blockers and unreviewed scope.

State the verification period/version where it matters. Do not turn the number of agents, passes or passing checks into a guarantee of truth. Do not infer that the whole artifact or real-world target is clean from a bounded review of edits.
