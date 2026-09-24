---
name: go-with-recommendations
description: Session — execute my recommendations in dependency order, deriving them from docs and code when none are explicit. Use when you say go ahead or run with it. Not for listing open items without acting.
argument-hint: "[optional focus, e.g. just the pricing items]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, Skill
---

# Go With Recommendations

The user has handed you the wheel. Your default answer to *"should I do this?"* is **yes** — proceed, and report what you did. Coming back with a plan and a question is the failure mode this skill exists to prevent.

That default is not permission to be careless. It is permission to stop asking about the **reversible** so you can spend the user's attention only on the **irreversible**.

## The contract

1. Read the mission, if the project has one.
2. Assemble the recommendation set — from the session first, from the project's own evidence if the session has none.
3. Order it by dependency.
4. Execute it, verifying each item.
5. Report what landed, what is blocked, and what is waiting on approval.

Do all five. Do not stop after step 3 to present the plan — that is the behaviour being replaced.

---

## Step 1 — Read the mission

Check for `docs/mission.md`. If present, **read it in full** before ordering anything.

The mission is a tie-breaker, not a work generator. Use it to decide *which* of two competing items goes first, and to catch a recommendation that is technically sound but pulls against a stated non-goal. Never derive new work from it — a mission statement will justify almost any task if you let it.

If there is no `docs/mission.md`, check `README.md` and `CLAUDE.md` for stated priorities and carry on. Say in the final report that no mission file was found.

---

## Step 2 — Assemble the recommendation set

Gather in this precedence order. Stop at the first source that yields a real set.

**A. Explicit recommendations in this session.** Anything you proposed and the user did not decline — offered next steps, "I'd suggest…", numbered options at the end of an answer, a deferred follow-up, a defect you found and flagged but did not fix. Include items you raised as asides; the user saying nothing about them is not a rejection.

**B. Commitments made in this session.** Things stated as pending: "I left X out of scope", "that needs a follow-up", "worth closing before Y". These are recommendations wearing different clothes.

**C. Derived from project evidence.** Only when A and B are empty — see Step 3.

Also honour any focus the user passed as an argument (`just the pricing items`). Narrow the set to match; do not silently widen it back.

**Freeze the set here.** Work discovered mid-execution gets reported at the end, not executed. An autonomous run that keeps growing its own scope is indistinguishable from one that has lost the plot.

---

## Step 3 — Derive recommendations when none are explicit

Only if Steps 2A and 2B came up empty. The goal is the **single best next action**, justified from evidence — not a wishlist.

Search in this order, stopping when you have enough to justify a recommendation:

1. **Session context** — unresolved threads, questions you answered but never acted on, anomalies you noted in passing.
2. **Project documentation** — a `docs/` tree, gotchas files, specs, `TODOS.md`, `CHANGELOG` "Unreleased" sections, `plan.md`. Look for stated-but-unfinished work.
3. **Source and repo state** — `git status` and recent commits for work in flight; `TODO`/`FIXME`/`XXX` markers; failing or skipped tests; a test suite that does not cover a path the docs say matters.

**Every derived recommendation must cite its evidence** — a file and line, a doc section, a command's output. A recommendation you cannot ground is a guess; drop it rather than dress it up.

**The bar.** Recommend only work that is (a) grounded in evidence you can point to, (b) within the spirit of what the user has been doing this session, and (c) something a careful colleague would agree is worth doing now. If nothing clears that bar, say so plainly and stop. "Nothing needs doing right now" is a valid, useful outcome — inventing filler work to look productive is not.

---

## Step 4 — Order by dependency

Sort the set so nothing runs before what it depends on. Apply these rules in order:

1. **Correctness before anything built on it.** If item B's premise is only true once A lands, A goes first. This is the rule that matters most and the one most often missed.
2. **Blocking before blocked.** Anything another item waits on goes first.
3. **Verification before the change it guards.** If the project's discipline is test-first, the test that fails goes before the fix that makes it pass. Follow whatever discipline the repo actually documents.
4. **Cheap and certain before expensive and uncertain.** Among independent items, land the sure things first so a later failure does not strand them.
5. **Mission priority as tie-breaker.** Only when the rules above leave two items genuinely equal.

State the order and the one-line reason for it before you start executing. The user should be able to see your reasoning without stopping you.

---

## Step 5 — Set the approval gate

Two lists. Everything not on the second list, you just do.

**Proceed without asking** — reversible, contained, inspectable:

- Reading anything.
- Writing and editing files in the working tree.
- Adding or changing tests; running the test suite, linters, type checks, builds.
- Writing and updating documentation.
- Local, read-only inspection commands.

**Stop and ask** — irreversible, outward-facing, or spending:

- Deploying to any live environment, or any infrastructure apply.
- Database migrations, and any write against a production datastore.
- Publishing a package, pushing to a remote, or opening a pull request.
- Anything that spends money or calls a paid API at volume.
- Deleting or overwriting anything not recoverable from version control.
- Sending anything to a third party or to other people.
- Anything the project's own instruction files (`CLAUDE.md`, `AGENTS.md`, contributing docs) name as requiring authorization — **these override this list; read them and honour them exactly.**

Committing sits on the line. Commit when the user has already asked for it or the project's workflow expects it; otherwise leave the tree clean and dirty, and say so.

When you hit a gated item: **do not stop the run.** Complete every other item first, then present the gated ones together at the end as one decision. Blocking the whole run on one approval wastes the autonomy the user just granted.

---

## Step 6 — Execute

For each item in order:

1. Do the work.
2. **Verify it** — run the test, the build, the command, the query. Match the project's own standard of proof; if it documents a discipline, follow that discipline rather than your own.
3. Record the outcome as exactly one of: **done**, **blocked**, or **needs approval**.

**If an item's premise turns out to be wrong** — the bug is not real, the fix is already in place, the file has moved — do not force it through. Mark it dropped, say why, and continue. Discovering a recommendation was mistaken is a successful outcome, not a failure to route around.

**If an item fails** — a test stays red, a command errors — attempt a reasonable fix. If it still fails, mark it blocked with the actual error text and move to the next item. Never leave the tree in a worse state than you found it: if a partial change cannot be completed, revert that item's edits rather than leaving them half-applied.

**Never** delete, loosen, or rewrite a test to make a run go green. A red test is information.

**Route to the project's own skills.** If the repo has a skill that owns the work you are about to hand-do (release, commit, migration, docs), invoke it rather than improvising the steps yourself.

---

## Step 7 — Report

Close with a short, scannable summary. Lead with what changed, not with process narration.

- **Done** — one line each, naming the verification that proves it.
- **Blocked** — what stopped it, with the real error.
- **Dropped** — what turned out not to need doing, and why.
- **Needs your approval** — the gated items, each with what it would do and what it would affect. Make these decidable in one read.
- **Found along the way** — anything you noticed but deliberately did not execute, per the frozen scope.

If the run produced nothing because nothing cleared the bar, say that in one line. Do not pad it.

---

## Constraints

- **NEVER** end this skill by presenting a plan and asking whether to proceed. That is the behaviour it replaces.
- **NEVER** expand the frozen set mid-run. Report new findings; do not act on them.
- **NEVER** fabricate a recommendation to have something to do. "Nothing needs doing" is a valid result.
- **NEVER** cross the approval gate on your own judgment, and never treat approval for one gated action as approval for the next.
- **NEVER** report an item as done without having verified it.
- **NEVER** weaken a test to reach green.
- **ALWAYS** read `docs/mission.md` when it exists, and use it to prioritise rather than to generate work.
- **ALWAYS** finish the ungated items before surfacing the gated ones.
- **ALWAYS** let the project's own instruction files override this skill where they conflict.
