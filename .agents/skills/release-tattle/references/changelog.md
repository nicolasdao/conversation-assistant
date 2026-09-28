# CHANGELOG.md rules

`CHANGELOG.md` (uppercase) in the project root, [Keep a Changelog](https://keepachangelog.com) format, [Semantic Versioning](https://semver.org/).

## Creating it (first run)

```markdown
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
```

## Categories and the bump they signal

| Category | For | Bump signal |
|---|---|---|
| Added | New features, endpoints, pages, capabilities | minor |
| Changed | Changes to existing behavior, UI, or API contracts | minor or patch |
| Deprecated | Features marked for removal | minor |
| Removed | Features or capabilities removed | major |
| Fixed | Bug fixes | patch |
| Security | Vulnerability fixes | patch or minor |

Bump: breaking change (removed features, changed API contracts, incompatible config or data) → major. New feature or capability → minor. Fixes, performance, refactors, dependencies, docs → patch. Nothing meaningful → no release (ask).

## Writing rules

- One bullet per logical change: squash related commits.
- Start with an imperative verb: Add, Fix, Remove, Change, Update, Deprecate.
- Specific but short: name the feature, endpoint, or file where it helps a reader.
- Write for the host and people who use the app, not for the diff: what they can now do, or what no longer breaks.
- Omit empty categories. Newest release at the top, below `## [Unreleased]`.
- `## [Unreleased]` is always present, even when empty.
- Versions in brackets with an ISO date: `## [0.2.0] - 2026-10-02`.

## Stamping a release (Modes A and B)

1. Move everything under `## [Unreleased]` into a new `## [<version>] - <YYYY-MM-DD>` section directly below it, merged with the entries from the change analysis (no duplicates).
2. Leave `## [Unreleased]` present and empty at the top.

## Recording unreleased changes (Mode C)

- Create `## [Unreleased]` below the header if it is missing.
- Create the `### <Category>` subsection if missing, then **append** your bullets.
- Amend, never replace: keep bullets other agents recorded. Skip a bullet that duplicates one already there.
- No version, no date: those are stamped only by a real release.
