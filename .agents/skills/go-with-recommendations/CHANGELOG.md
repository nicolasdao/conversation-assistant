# Changelog

All notable changes to this skill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-22

### Added

- Initial release.
- Five-step contract: read the mission, assemble the recommendation set, order it by dependency, execute with verification, report.
- Reads `docs/mission.md` when present and uses it strictly as a prioritisation tie-breaker, never as a source of new work.
- Three-tier recommendation sourcing — explicit session recommendations, then session commitments, then evidence derived from docs, repo state and source. Derived items must cite the evidence that grounds them.
- Dependency ordering rules, led by correctness-before-dependants and verification-before-the-change-it-guards.
- Two-list approval gate: reversible and contained work proceeds unasked; irreversible, outward-facing and spending actions stop. A project's own instruction files override the gate.
- Gated items are collected and presented once at the end rather than halting the run.
- Scope is frozen after assembly — work discovered mid-run is reported, not executed.
- User-invoked only (`disable-model-invocation: true`), so an autonomous executor can never self-trigger.
