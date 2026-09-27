---
name: release-conversation-assistant
description: Release — cut a conversation-assistant version by bumping package.json, updating CHANGELOG.md, tagging, pushing, and publishing the Mac app. Use when asked to release, ship a version, bump the version, or record unreleased changes. Not for running the app.
argument-hint: "[patch|minor|major|unreleased|auto] [description]"
arguments: [action, note]
allowed-tools: Bash, Read, Edit, Write, Grep, AskUserQuestion, Skill
---

# Release conversation-assistant

Cuts a release of this project: bring the docs up to date and commit everything, then analyse what changed, write the changelog, bump the version, commit, tag, push, and publish the Mac app. Or, with `unreleased`, record work into the changelog's `[Unreleased]` ledger without releasing.

**Project facts** (standalone repo, branch `master`, remote `origin`):

| | |
|---|---|
| Version | `version` in the root `package.json` — the **only** place it lives. The server reads it (`GET /api/about`) and the app shows it in the settings menu footer. Never write it anywhere else. `package-lock.json` follows via `npm version`. |
| Tag | `v<version>`, annotated |
| Changelog | `CHANGELOG.md` in the project root, Keep a Changelog — rules in [references/changelog.md](references/changelog.md) |
| Gates | `npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop` — offline, no API spend |
| First release | No `v*` tag yet → release the current `0.1.0` as-is (no bump), analysing the whole history |
| Published | The Mac app, as a GitHub Release `v<version>` with the DMG people download and the files the installed app updates from (Step 9, `docs/desktop.md`). Never to npm. |

Run every script from the project root: `sh "${CLAUDE_SKILL_DIR}/scripts/<script>"`.

## Arguments

- `$action` (optional): `patch`, `minor`, `major` (explicit bump), `unreleased` (Mode C), or `auto` / omitted (you decide the bump).
- `$note` (optional): a description of what ships. Reflect it in the changelog and weigh it in the bump (a note describing a breaking change means major). It adds to the git analysis, never replaces it.

## Step 1 — Mode

- `$action` is `unreleased` → **Mode C** (go to the Mode C section).
- This session did meaningful work on this project (edits, fixes, features) → **Mode A**: use session context and git.
- Otherwise → **Mode B**: git only, and ask for context (Step 4).

## Step 2 — Docs, then commit everything (Modes A and B)

A release ships the whole working tree, so it starts by making the docs current and committing every pending change. This uses two skills this one depends on (`skill.json` `dependencies`):

1. **Update the docs.** Invoke the `update-doc` skill (`nicolasdao/update-doc`) with no notes. Let it finish its full workflow: docs updated where the changes warrant it, and the doc manifest regenerated.
2. **Commit everything.** Invoke the `git-commit` skill (`nicolasdao/git-commit`) with this guidance: *"Commit every change in the working tree, including files changed outside this session and untracked files, not only this session's work. Still exclude secrets (.env and similar) and anything git ignores."* It may split the work into several commits by theme. The release commit that follows contains only release metadata, so these commits carry the actual changes.
3. If there was nothing to update or commit, both skills say so. Carry on.

If either skill stops with an error, or you or the user declined a commit, stop the release and report why. Never paper over it: the next step would refuse anyway.

## Step 3 — Pre-flight (Modes A and B: a hard gate)

1. `sh "${CLAUDE_SKILL_DIR}/scripts/preflight.sh" release`. After Step 2 the tree should be clean; anything left means something was not committed. If it fails, show its output verbatim and **stop**. Never offer to proceed anyway: the release commits only `package.json`, `package-lock.json` and `CHANGELOG.md`, so uncommitted code would ship under a tag that doesn't contain it.
2. `sh "${CLAUDE_SKILL_DIR}/scripts/checks.sh"`. If a gate fails, show the failure and stop.

## Step 4 — What ships

Run `sh "${CLAUDE_SKILL_DIR}/scripts/release-info.sh"`: current version, last tag, commits since it, and any `[Unreleased]` notes.

Sources, in priority order:
1. **Session context** (Mode A): intent and reasons, not just what the diff shows.
2. **`$note`**, always respected.
3. **`[Unreleased]` notes** from earlier Mode C runs: the head start, cross-checked against newer commits.
4. **Git log** since the last tag (the whole history for the first release), ignoring merge commits.
5. **Diffs** (`git diff <last-tag>..HEAD -- <path>`) where a commit message is unclear.

If the tag and `package.json` disagree, trust `package.json`.

**Mode B:** before classifying, ask: "I don't have session context for this project. Here's what I found from git. Is there anything the commits don't capture — intent, trade-offs, or context I should know?"

**Nothing meaningful** (only CI, formatting, internal tweaks): say so, summarise what changed, and ask with AskUserQuestion whether to release a patch anyway or skip.

## Step 5 — Classify and choose the bump

Group the changes into Keep a Changelog categories, one bullet per logical change, and choose the bump from them ([references/changelog.md](references/changelog.md)).

- An explicit `$action` **lower** than the changes warrant (e.g. `patch` with new features): warn and ask. Never silently downgrade.
- An explicit `$action` **higher**: use it, no warning.
- First release: `0.1.0`, no bump.

## Step 6 — Confirm (before anything irreversible)

AskUserQuestion, presenting: current → new version, the bump and why, the full changelog entry, and what will happen (files changed, commit message, tag name). Options: **Release**, **Change the bump**, **Edit the changelog first**, **Abort**.

## Step 7 — Write, commit, tag

1. Create `CHANGELOG.md` if missing, then stamp the release ([references/changelog.md § Stamping](references/changelog.md)): the entries go under `## [<version>] - <today>`, and `## [Unreleased]` stays, empty.
2. `sh "${CLAUDE_SKILL_DIR}/scripts/apply-release.sh" <version> "<attribution>"`, passing the session's commit attribution line (`Co-Authored-By: …`) when there is one. It sets the version (skipped when unchanged), stages only `package.json`, `package-lock.json` and `CHANGELOG.md`, commits `chore(release): conversation-assistant v<version>`, and tags `v<version>`.

## Step 8 — Push (a second confirmation)

AskUserQuestion: push the release commit and tag `v<version>` to `origin`? On yes, `sh "${CLAUDE_SKILL_DIR}/scripts/push.sh" <version>`. On no, remind: `git push origin master && git push origin v<version>`.

Then Step 9.

## Step 9 — Publish the Mac app (a third confirmation)

Only after the push. Publishing is outward-facing: installed apps download what it publishes, so it is never automatic.

1. Check the requirements without building: `security find-identity -v -p codesigning | grep "Developer ID Application"`, and notary credentials: `xcrun notarytool history --keychain-profile conversation-assistant` succeeds, or `APPLE_KEYCHAIN_PROFILE`, `APPLE_API_KEY` or `APPLE_ID` is set. If either is missing, skip this step and say why: until the Developer ID and its notary credentials exist, the Mac app is not published (see `docs/desktop.md` § Signing). Never publish an ad-hoc build.
2. AskUserQuestion: publish the Mac app for `v<version>` as a GitHub Release, which every installed copy will offer to update to? Options: **Publish**, **Not now**.
3. On yes, write the version's changelog entry (its bullets, without the `## [x.y.z]` heading) to a temporary notes file, then `sh "${CLAUDE_SKILL_DIR}/scripts/publish-app.sh" <version> <notes-file>`. It builds from the tag, checks the signature, notarization and Gatekeeper, and creates the release with the DMG, the zip, their blockmaps, and `latest-mac.yml`. If it fails, show its output and stop; nothing is published before its last line.
4. On "Not now", remind: from the tag, `sh .claude/skills/release-conversation-assistant/scripts/publish-app.sh <version> <notes-file>`.

Finish with: the version, the tag, the changelog entry, whether it was pushed, and whether the Mac app was published (with the release URL). Installed apps pick up a published version within a few hours, or at their next launch.

## Mode C — Record unreleased changes (the ledger)

For recording work between releases. **No version bump, no tag, `package.json` untouched.** Several agents can share one branch: each records **its own** changes, and the next real release promotes the whole `[Unreleased]` section, so nothing ships unrecorded.

1. `sh "${CLAUDE_SKILL_DIR}/scripts/preflight.sh" ledger`. Uncommitted code is expected, but only `CHANGELOG.md` must be free of unstaged edits. Recommend committing the code first: an entry for uncommitted code is misleading.
2. Identify **your own** changes (session context, `$note`, your commits since the last release). Do not inventory other agents' work.
3. Create or amend `## [Unreleased]` ([references/changelog.md § Recording](references/changelog.md)): append bullets under the right categories, keep everyone else's, skip duplicates, no version or date.
4. `sh "${CLAUDE_SKILL_DIR}/scripts/record-unreleased.sh" "<short summary>" "<attribution>"`. It commits only `CHANGELOG.md`.
5. Push posture matches a real release: ask, then `git push origin master`. If rejected because another agent pushed, `git pull --rebase`; in a `[Unreleased]` conflict, keep **both** agents' bullets.
6. Show which bullets were added under which category, awaiting the next release.

## Constraints

- **Always** run Step 2 first in Modes A and B: `update-doc`, then `git-commit` committing everything (secrets and ignored files excepted). Mode C does neither.
- **Never** release with uncommitted changes (Modes A and B), and never offer to.
- **Never** put anything but `package.json`, `package-lock.json` and `CHANGELOG.md` in the release commit itself (Mode C: only `CHANGELOG.md`); every other change goes in Step 2's commits.
- **Never** write the version anywhere but `package.json` (via `npm version`).
- **Always** confirm before the commit and tag, separately before the push, and separately before publishing the Mac app.
- **Never** publish a Mac app signed ad hoc or not notarized: `publish-app.sh` refuses, and nothing is to be done around it.
- **Never** push `--tags` wholesale: push the release branch and the one new tag.
- **Never** run the app, `npm run smoke`, `preflight`, or anything that calls paid APIs as a release gate.
- Keep every path relative to the project root or `${CLAUDE_SKILL_DIR}`.
