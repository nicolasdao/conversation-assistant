# Changelog

All notable changes to the `scrutinize` skill are documented here.

## [0.2.0] - 2026-09-12

### Added
- Track material claims, evidence, affected uses and review status, including explicit unresolved and unchecked states.
- Add a conditional expanded review with focused independent readers, applicability counterexamples, challenges to findings and swapped verification of material fixes.
- Add synthetic review cases and separate expectations for maintainers to exercise missed errors and false positives without publishing task-specific evidence.

### Changed
- Inspect actual and untracked artifacts as well as diffs; propagate each correction through equivalent statements and dependent decisions before closure.
- Require source applicability and distinguish substantive correctness from structural, hash and wording checks.
- Replace the assumption that an unproven issue is unreal with explicit evidence limits; preserve unknowns without inventing defects or certifying compliance.
- Define bounded stopping criteria and preserve existing authorization when further decisions are considered.
- Add primary-source web tools while retaining manual invocation and the existing no-commit/no-release review boundary.

## [0.1.0] - 2026-06-01

### Added
- Initial release. Same-session self-review that scopes to the session diff, spawns a read-only cold-reader sub-agent, runs a simple-gaps pass and a harvest-corrections pass (fed by accumulated learning), reconciles the two (disagreements are blind spots), proves every finding before fixing (failing test, primary-source evidence, or grep), auto-applies the green fixes and surfaces the risky ones, then confirms with the targeted and broad test suites. Includes the "expand the problem" altitude check and the "distrust your own narrative" posture.
