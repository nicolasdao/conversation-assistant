---
name: release-tattle
description: Release — cut a Tattle version and deploy it to production (the signed Mac app on GitHub Releases, which installed copies update to, and hey-tattle.com's download link), after bumping package.json, updating CHANGELOG.md, and tagging. Use when asked to release, ship, deploy, bump the version, or record unreleased changes. Not for running the app.
argument-hint: "[patch|minor|major|unreleased|auto] [description]"
arguments: [action, note]
allowed-tools: Bash, Read, Edit, Write, Grep, AskUserQuestion, Skill
---

# Release Tattle

Cuts a release of this project and deploys it: bring the docs up to date and commit everything, analyse what changed, write the changelog, bump the version, commit and tag **locally**, build and verify the Mac app **locally**, then deploy to production (push, and publish the GitHub Release), verify production from the outside, and point the website (hey-tattle.com) at the new release. Or, with `unreleased`, record work into the changelog's `[Unreleased]` ledger without releasing.

**Project facts** (standalone repo, branch `master`, remote `origin`):

| | |
|---|---|
| Version | `version` in the root `package.json` — the **only** source of it. The server reads it (`GET /api/about`) and the app shows it in the settings menu footer. `package-lock.json` follows via `npm version`. The one other place a version appears is the website, which names the latest **published** release; only `update-website.sh` writes it, after deployment (Step 12). |
| Tag | `v<version>`, annotated |
| Changelog | `CHANGELOG.md` in the project root, Keep a Changelog — rules in [references/changelog.md](references/changelog.md) |
| Gates | The whole test suite in Step 1 (`test-suite.sh`: `npm run test:all`, with coverage thresholds, the Swift tests and the end-to-end tests), then `npm run typecheck`, `npm test`, `npm run build:web`, `npm run build:desktop`, and the third-party notices check (`checks.sh`) in Step 4 — no API spend; offline, except that right after a clean install the notices check downloads Electron's binary once |
| First release | No `v*` tag yet → release the current `0.1.0` as-is (no bump), analysing the whole history |
| Production | There is no server: production is the GitHub Release `v<version>` — the DMG new users download, and the update every installed copy offers within about 4 hours or at its next launch (`docs/desktop.md`). Never npm. |
| Website | https://hey-tattle.com, the page in `website/` (`docs/website.md`). Its Download for Mac links, the version under the button, the footer's "Latest release" line, and its JSON-LD name the latest published release. Cloudflare redeploys the site by itself on any push to `master` that changes `website/`. |
| Final | A pushed tag and a published release can never be moved, replaced, or deleted (tag rules, immutable releases). A mistake found after the push is fixed forward, with a new version. That is why the app is built and verified **before** anything is pushed. |

Run every script from the project root: `sh "${CLAUDE_SKILL_DIR}/scripts/<script>"`.

## Arguments

- `$action` (optional): `patch`, `minor`, `major` (explicit bump), `unreleased` (Mode C), or `auto` / omitted (you decide the bump).
- `$note` (optional): a description of what ships. Reflect it in the changelog and weigh it in the bump (a note describing a breaking change means major). It adds to the git analysis, never replaces it.

## Step 1 — Test suite (Modes A and B; a hard gate; no API spend)

- `$action` is `unreleased` → skip to **Mode C**, which never runs the suite.
- Otherwise run `sh "${CLAUDE_SKILL_DIR}/scripts/test-suite.sh"` (about 10 minutes; run it in the background and wait). It checks what the suite needs (the models and fixture, Playwright's Chromium, `swift`), saying how to get what is missing, then runs `npm run test:all`: type checks, the unit and DOM tests with the coverage thresholds, the capture helper's Swift tests with their coverage gate, and the end-to-end tests of the web page and of the Mac app (development build, offline, no keys, an isolated HOME). Every service is faked: it spends nothing and needs no network.
- If it fails, show the failing tests (or the coverage table, or the missing prerequisite and its fix) and **stop**, before any doc update or commit. A red test is a finding, never something to skip, loosen, or retry until it passes (docs/testing.md).

It runs first because it is the likeliest to fail and the cheapest to undo: nothing has been written or committed yet. The tests run on the working tree, which is exactly what Step 3 then commits.

## Step 2 — Mode

- `$action` is `unreleased` → **Mode C** (go to the Mode C section; it never reaches Step 1's suite).
- This session did meaningful work on this project (edits, fixes, features) → **Mode A**: use session context and git.
- Otherwise → **Mode B**: git only, and ask for context (Step 5).

## Step 3 — Docs, then commit everything (Modes A and B)

A release ships the whole working tree, so it starts by making the docs current and committing every pending change. This uses two skills this one depends on (`skill.json` `dependencies`):

1. **Update the docs.** Invoke the `update-doc` skill (`nicolasdao/update-doc`) with no notes. Let it finish its full workflow: docs updated where the changes warrant it, and the doc manifest regenerated.
2. **Commit everything.** Invoke the `git-commit` skill (`nicolasdao/git-commit`) with this guidance: *"Commit every change in the working tree, including files changed outside this session and untracked files, not only this session's work. Still exclude secrets (.env and similar) and anything git ignores."* It may split the work into several commits by theme. The release commit that follows contains only release metadata, so these commits carry the actual changes.
3. If there was nothing to update or commit, both skills say so. Carry on.

If either skill stops with an error, or you or the user declined a commit, stop the release and report why. Never paper over it: the next step would refuse anyway.

## Step 4 — Pre-flight (Modes A and B: a hard gate)

1. `sh "${CLAUDE_SKILL_DIR}/scripts/preflight.sh" release`. After Step 3 the tree should be clean; anything left means something was not committed. If it fails, show its output verbatim and **stop**. Never offer to proceed anyway: the release commits only `package.json`, `package-lock.json` and `CHANGELOG.md`, so uncommitted code would ship under a tag that doesn't contain it.
2. `sh "${CLAUDE_SKILL_DIR}/scripts/checks.sh"`. If a gate fails, show the failure and stop.
3. `sh "${CLAUDE_SKILL_DIR}/scripts/credentials.sh"`: can this Mac deploy (the Developer ID certificate and how long it has left, the notary credentials, GitHub access)? Relay any `warning` or `note` line. If it fails, show its output, and ask with AskUserQuestion: **Stop** (fix the credentials, then release), or **Release without deploying** (Steps 5–8 only: the commit and tag stay on this Mac, and deploying later needs Steps 9–11). Never tag and push a version that is not deployed: the version number would be spent without an app.

## Step 5 — What ships

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

## Step 6 — Classify and choose the bump

Group the changes into Keep a Changelog categories, one bullet per logical change, and choose the bump from them ([references/changelog.md](references/changelog.md)).

- An explicit `$action` **lower** than the changes warrant (e.g. `patch` with new features): warn and ask. Never silently downgrade.
- An explicit `$action` **higher**: use it, no warning.
- First release: `0.1.0`, no bump.

## Step 7 — Confirm the release

AskUserQuestion, presenting: current → new version, the bump and why, the full changelog entry, and what will happen next: the release commit and tag are made **on this Mac only**, then the app is built and verified locally; nothing is pushed or published until Step 10 asks. Options: **Release**, **Change the bump**, **Edit the changelog first**, **Abort**.

## Step 8 — Write, commit, tag (on this Mac only)

1. Create `CHANGELOG.md` if missing, then stamp the release ([references/changelog.md § Stamping](references/changelog.md)): the entries go under `## [<version>] - <today>`, and `## [Unreleased]` stays, empty.
2. `sh "${CLAUDE_SKILL_DIR}/scripts/apply-release.sh" <version> "<attribution>"`, passing the session's commit attribution line (`Co-Authored-By: …`) when there is one. It sets the version (skipped when unchanged), stages only `package.json`, `package-lock.json` and `CHANGELOG.md`, commits `chore(release): tattle v<version>`, and tags `v<version>`, locally.

## Step 9 — Build and verify the app (on this Mac only)

`sh "${CLAUDE_SKILL_DIR}/scripts/build-app.sh" <version>` (about 5 minutes, mostly Apple's notarization; run it in the background and wait). It installs exactly the locked dependencies, verifies their registry signatures, refuses a high-severity advisory in what ships, checks the third-party notices, builds, has Apple notarize, checks the signature, the stapled ticket, and Gatekeeper, fetches the GPL sources, and writes the SBOM and `out/SHA256SUMS`. Nothing is pushed or published.

**If it fails:** show the failure, then `sh "${CLAUDE_SKILL_DIR}/scripts/undo-local-release.sh" <version>`, which deletes the local tag and release commit, so nothing is lost and the same version can be released after the fix. Stop there; the fix is new work, committed on its own, and the release starts again from Step 1.

## Step 10 — Deploy to production (the one outward-facing confirmation)

AskUserQuestion, stating plainly: deploying pushes `master` and the tag `v<version>` to `origin` and publishes the GitHub Release, which new users download and **every installed copy will install**; it cannot be undone or replaced (a problem found later means a new version). Say too that once production is verified, the website is updated to link the new DMG (a commit to `website/index.html` only, pushed to `master`, which Cloudflare deploys). Options: **Deploy**, **Not now**.

- **Deploy:** write the version's changelog entry (its bullets, without the `## [x.y.z]` heading; include earlier versions' entries that were tagged but never deployed) plus an **Install** paragraph to a temporary notes file, then `sh "${CLAUDE_SKILL_DIR}/scripts/deploy.sh" <version> <notes-file>`. It refuses unless `build-app.sh` verified a build of exactly this commit and the built files are unchanged; then it pushes, and creates the release with the DMG, the zip, their blockmaps, `latest-mac.yml`, the SBOM, the GPL sources, and the checksums in the notes. If the push succeeded but publishing failed, rerun `deploy.sh`: it skips what is done.
- **Not now:** everything stays on this Mac, and the website is not touched. Remind: deploy later with `sh .claude/skills/release-tattle/scripts/deploy.sh <version> <notes-file>` (from the same commit, with `out/` intact), or drop the release with `undo-local-release.sh <version>`.

## Step 11 — Verify production

`sh "${CLAUDE_SKILL_DIR}/scripts/verify-release.sh" <version>`: without logging in, the update feed installed apps read names `<version>`, the published DMG matches the build, and a downloaded copy, flagged as from the internet, passes Gatekeeper as notarized. If it fails, show it and say that the release is live but unverified.

## Step 12 — Point the website at the release

Runs after a deployment (Step 10), without a further confirmation: Step 10's confirmation covered it. If Step 11 failed, ask with AskUserQuestion first (**Update the website**, **Leave it**): the site would link a release that did not pass verification.

1. `sh "${CLAUDE_SKILL_DIR}/scripts/update-website.sh" <version>`. It reads the **published** release from GitHub (so it refuses a version that is not published) and writes its version, DMG link, size, date, and release-notes link into `website/index.html`: the two Download for Mac links, the line under the button, the footer's "Latest release" line, and the JSON-LD `softwareVersion` and `downloadUrl`. It changes no other file and can be run again. If it reports that the page no longer has the elements it expects, stop and say so: the page changed and the script must be updated to match, not worked around by hand.
2. `sh "${CLAUDE_SKILL_DIR}/scripts/deploy-website.sh" <version> "<attribution>"`. It commits `website/index.html` alone (`chore(website): point the download and release line at v<version>`), pushes `master`, and waits until https://hey-tattle.com links the new DMG (usually about 3 minutes, at most 10). If it times out, the push is done: say so and point to the build under **Workers & Pages → tattle-website → Deployments** in the Cloudflare dashboard.

The page's own script also reads the latest release from GitHub when it loads, so visitors see a new release even before this step lands; this step makes the page right without JavaScript, for search engines, and when GitHub's API limit is reached.

Finish with: the version, the tag, the changelog entry, whether it was deployed (with the release URL) and verified, whether hey-tattle.com links it, and any credentials warning from Step 4. Installed apps offer the new version within about 4 hours, or at their next launch.

## Mode C — Record unreleased changes (the ledger)

For recording work between releases. **No version bump, no tag, `package.json` untouched.** Several agents can share one branch: each records **its own** changes, and the next real release promotes the whole `[Unreleased]` section, so nothing ships unrecorded.

1. `sh "${CLAUDE_SKILL_DIR}/scripts/preflight.sh" ledger`. Uncommitted code is expected, but only `CHANGELOG.md` must be free of unstaged edits. Recommend committing the code first: an entry for uncommitted code is misleading.
2. Identify **your own** changes (session context, `$note`, your commits since the last release). Do not inventory other agents' work.
3. Create or amend `## [Unreleased]` ([references/changelog.md § Recording](references/changelog.md)): append bullets under the right categories, keep everyone else's, skip duplicates, no version or date.
4. `sh "${CLAUDE_SKILL_DIR}/scripts/record-unreleased.sh" "<short summary>" "<attribution>"`. It commits only `CHANGELOG.md`.
5. Push posture matches a real release: ask, then `git push origin master`. If rejected because another agent pushed, `git pull --rebase`; in a `[Unreleased]` conflict, keep **both** agents' bullets.
6. Show which bullets were added under which category, awaiting the next release.

## Constraints

- **Always** run Step 1 (the test suite) and Step 3 (`update-doc`, then `git-commit` committing everything, secrets and ignored files excepted) before anything else in Modes A and B. Mode C does neither.
- **Never** release with uncommitted changes (Modes A and B), and never offer to.
- **Never** put anything but `package.json`, `package-lock.json` and `CHANGELOG.md` in the release commit itself (Mode C: only `CHANGELOG.md`); every other change goes in Step 3's commits. The website commit (Step 12) contains only `website/index.html`.
- **Never** point the website at a version before its GitHub Release is published: the links would lead to a missing DMG. `update-website.sh` refuses, and nothing is to be done around it.
- **Never** write the version anywhere but `package.json` (via `npm version`), except the website's record of the published release, which only `update-website.sh` writes, after deployment (Step 12).
- **Always** confirm before the local commit and tag (Step 7), and separately before deploying (Step 10), which is the only step that sends anything out.
- **Never** push a release tag before `build-app.sh` has verified the app for that exact commit: a pushed tag is permanent, so a failed build after it would spend the version number.
- **Never** try to move, delete, or replace a pushed tag or a published release: fix forward with a new version.
- **Never** deploy a Mac app signed ad hoc or not notarized: `build-app.sh` and `deploy.sh` refuse, and nothing is to be done around them.
- **Never** push `--tags` wholesale: push the release branch and the one new tag.
- **Never** run the app against real services (`npm run smoke`, `preflight`, a real session) or anything that calls paid APIs as a release gate; the Step 1 suite runs the development app offline, with no keys and an isolated HOME.
- Keep every path relative to the project root or `${CLAUDE_SKILL_DIR}`.
