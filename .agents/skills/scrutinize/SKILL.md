---
name: scrutinize
description: Scrutinize — Review and fix your own recent work with independent checks and evidence. Use after substantial changes in the same session. Not for auditing work you did not produce.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, AskUserQuestion, WebSearch, WebFetch
---

# Scrutinize

Re-examine the work you just finished, prove what is actually wrong, and fix it — using the knowledge you have **now**, at the end, that you lacked when you made the early decisions. This is a second pass with new information, not a re-run of the same thinking.

If `$ARGUMENTS` names a focus or paths, scope the review to that. Otherwise the scope is everything you changed this session.

## Posture — read first

- This is **setting yourself up for success, not catching yourself out.** You just finished; you now hold more context and focus than at any single decision point. Spend that surplus.
- Be adversarial toward your own **beliefs**, not your competence. Assume at least one early decision rode on an assumption that turned out wrong.
- Your accumulated context is **fuel for the facts you learned, but fog for your objectivity** — by now you are attached to your own solution. Harvest what the work taught you, but distrust how it made you feel about what you built. This is exactly why the cold reader exists — it holds the facts without the attachment.
- **"Clean" is a valid, honest result.** Never manufacture findings to look thorough — that is rubber-stamping inverted. A finding counts only once you can **prove** it (Step 4).
- You **do not commit, push, or release.** You surface and fix; the human commits.

## When this works

Same session, right after a **substantial** change. Your live reasoning trail — what you assumed, looked up, and decided while working — is the fuel, so the harvest in Step 2 is far weaker on a cold diff. Skip this for trivial edits.

## The pipeline

### 0 — Scope
Run `git status --short`, `git diff`, and `git diff --staged` where Git is available. Inspect untracked files and the actual artifact too; an empty diff does not prove there is nothing to review. Without a repository, use the session's before/after artifacts. List what you changed and restate the original ask in one line. Review that scope and affected uses; honor any explicit narrowing without silently certifying the rest.

Track material claims or behaviors in brief working notes: source/version and locator, occurrences and dependent decisions, reviewer/lens, status and remaining evidence. Use `unchecked`, `supported`, `issue`, `unresolved`, `rejected` or `fixed-verified`; a suspected issue becomes `issue` only after Step 4. Update these notes through the review so a later pass can target gaps. Small changes need only a short list, not a new repository artifact.

**Scale the review.** For consequential work (for example legal, medical, financial or security decisions), complex work spanning several domains, or an explicit team review, read [Expanded review](references/expanded-review.md). It adds focused independent reviewers, applicability counterexamples and swapped verification. Keep the ordinary single cold reader for smaller work. If tools or reviewers are unavailable, record the coverage limitation and continue the checks available; do not pretend independent review occurred.

### 1 — Cold reader (spawn first, let it run in parallel)
Spawn a fresh sub-agent (general-purpose, read-only). Give it the **original ask**, the **artifact and diff**, and read access to relevant context — but **not** your reasoning, prior verdicts or justifications for why the solution is right. Instruct it to independently find (a) gaps and omissions and (b) decisions resting on a wrong assumption, each **grounded in primary evidence with an exact locator**, and to make **no changes**. Request supported findings, rejected candidates and unresolved evidence separately. Let independent first passes finish before exchanging findings.

### 2 — Your two passes (run independently of the cold reader, so neither anchors the other)

**Simple pass — find the gaps.** Re-read the diff as a *reader*, not the writer — what is on the page, not what you meant. Look for:
- omissions and incompleteness versus the literal ask;
- **missing accompaniments** — for a change *like this one*, what usually rides along (a test, a doc, a changelog entry, a migration, an updated caller)? Derive this from the *kind* of change, not a fixed checklist;
- **seam breaks** — where your change meets unchanged code (callers, consumers, the other half of a rename);
- leftovers — debug output, TODOs, scaffolding, temp files.

**Harvest — find the wrong beliefs.** Do not summarize what you learned; find where your map was wrong. Mine these veins:
- **reversals** — moments a result surprised you or you backtracked;
- **inherited claims** — anything you took from a doc, a comment, your memory, or "I think" without checking primary source at the time;
- **generalizations** — every blanket rule you asserted (confirmed at every site, or extrapolated from one?);
- **late-vs-early** — what you knew by the end but committed to before knowing it;
- **your own "because" clauses** — each load-bearing rationale you stated, re-verified against source.

Write each harvest finding as a triple:
> **ASSUMED** (and where it came from) → **TRUE** (with primary-source evidence, file:line) → **RODE ON IT** (the decisions/files that depended on it)

Do not promote an ungrounded suspicion into a finding; retain material uncertainty as `unresolved`. Rank supported findings by how much rode on them. Feed the harvest the **union** of your accumulated learning and the simple-pass findings — a forgotten caller is often the symptom of an assumed-single-caller.

For material rules or boundaries, test applicability: who or what is covered, the operative version/date, triggering event, conditions, exceptions and permitted alternatives. Construct a valid case the claim might wrongly reject and an invalid case it might wrongly accept. Verify those counterexamples against the source or executable behavior. Distinguish a required outcome from a suggested implementation, a draft from an operative rule, and a recommended decision from a proven fact.

**One altitude higher — did the work reveal the wrong problem?** The deepest finding is not a wrong assumption inside the solution but a wrong *problem*. Building the thing often exposes that what you set out to fix was the wrong, smaller, or merely symptomatic version of the real issue. Ask it explicitly: now that it exists, is this still the problem worth solving, or did the work surface a bigger or different one? That reframe is the highest-value thing this pass can find — and it is not yours to fix: it is a direction call, so **surface it to the human, never act on it unilaterally.**

### 3 — Reconcile
Merge your findings with the cold reader's. Weight the **disagreements** heavily — anything it flagged that you did not, or you flagged that it did not, is a blind spot. Challenge each material candidate using the strongest contrary evidence and its surrounding qualifications. A reasonable evidence request is not automatically a false claim; reviewer agreement is not proof. Record why candidates are accepted, rejected or unresolved.

### 4 — Prove (mandatory gate before any fix)
For each candidate, produce the strongest proof its type admits:
- behavioral bug → a **failing unit test** that reproduces it (gold standard);
- doc or claim inaccuracy → **primary-source evidence** that applies to the exact subject, version and time; retain the section/page/code locator and relevant conditions;
- completeness gap → a **grep or command** that shows the missing site.

The proof is also a **false-positive filter**. Failure to reproduce or retrieve evidence means the issue is **not established**, not that the artifact is correct. Reject a candidate when evidence or context defeats it; preserve a material unknown with the evidence needed to resolve it. A proven evidence gap can justify qualifying an unsupported assertion, but does not prove the opposite assertion. Never invent a factual correction to close an unknown.

When the finding is a recurring *class*, preserve a meaningful regression case or durable guard. State what it proves: hashes, links and required phrases can protect consistency but cannot establish factual truth, legal applicability or runtime correctness. Exercise a known bad case and a valid alternative where practical; do not count a restatement of the implementation as independent proof.

### 5 — Fix
- **Auto-apply** proven fixes within the authorized scope that you can verify.
- **Propagate each fix.** Search the scoped artifact and affected consumers for exact wording, equivalent numbers/terms, summaries, tables, examples, tests and dependent conclusions. Update every affected use or record why it remains correct. Keep the issue open until this search and the dependent-decision check are complete; fixing one occurrence is not closure. Preserve any designated historical evidence and distinguish it from current guidance.
- **Surface** unsupported corrections or changes requiring a new scope/risk decision. Do not implement them merely to clear the review. Continue independent authorized work; seek a decision only where needed, respecting existing authorization.

### 6 — Confirm (two kinds of evidence, both required)
- **Correctness of the fix:** targeted behavioral tests pass for code; for factual work, the primary evidence supports the final wording, conditions and conclusions. An independent reader checks material corrections against that evidence.
- **Integration and consistency:** run the full relevant checks and verify propagation through affected uses. For code this includes the appropriate broader tests; for documents it includes cross-references, repeated claims, source integrity and structure. A passing text/hash check is not a substitute for the correctness check.

Record what was actually checked and mark the issue `fixed-verified` only when both succeed. If evidence or execution is unavailable, retain that limitation rather than report a green. Reopen affected checks when a correction changes their assumptions; do not repeat unrelated checks without a reason.

### 7 — Bound and report
Light-check the fixes themselves (a leftover, a broken seam?) — not a full re-harvest. Stop when the agreed material areas are assessed or explicitly unresolved, proven issues are fixed and verified or awaiting a stated decision, affected uses are checked, and the final review of changes has no new substantiated issue. **Do not chase certainty or label unchecked work clean.** Any remaining blocker limits the conclusion; it does not require endless re-reading. Then report, in plain language:
- what you **proved and fixed**, each with its evidence and the confirming test;
- what you **surfaced** for the human to decide;
- what was checked without finding a proven issue, and the precise scope and limits of that result.

When maintaining this skill itself, use the synthetic cases in [Review evaluation](references/review-evaluation.md); do not load evaluation answers during an ordinary artifact review.

## The one rule that makes this work

Every finding is **grounded in primary source** and **proven before it is fixed.** Memory, comments, and secondary docs are where the bugs came from — go to the actual code, the actual data, the actual output. That single discipline catches what a re-read of your own reasoning never will.

## Constraints

- **NEVER** commit, push, tag, or release. Surface and fix only.
- **NEVER** apply an unsupported factual correction — Step 4 is a hard gate. Preserve material unresolved evidence without presenting it as a defect or a clean result.
- **NEVER** manufacture findings to look thorough. Reporting "clean, here is the evidence" is a correct outcome.
- **ALWAYS** ground every finding in primary source (file:line or command output), not memory or secondary docs.
- **ALWAYS** verify correctness and the full relevant consistency/integration checks after fixing.
- **ALWAYS** trace material corrections through affected uses and dependent conclusions before closure.
- **ALWAYS** obtain any genuinely missing decision for changes beyond authorized scope; do not re-request authorization already given.
- **PREFER** promoting a recurring-class proof into a durable test over a one-shot check.
- The cold-reader sub-agent is **read-only** — it reviews, you fix.
