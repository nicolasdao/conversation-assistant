# Changelog

All notable changes to this skill are documented here.

## [0.4.3] - 2026-07-06

### Added
- **Added the missing `Zone | Single Redirect | Edit` row to the combined-token table in `references/token-model.md`.** Redirect Rules (single/dynamic URL redirects, the `http_request_dynamic_redirect` rulesets phase — e.g. a www→apex 301) are part of the constellation's write surface via `cloudflare-config`, but the table had no permission covering them, so a token built from the "100% of the surface" manual could not create them (`request is not authorized`). `Zone Settings: Edit` does **not** cover the rulesets engine. Cloudflare renamed this group from "Dynamic Redirect" to **"Single Redirect"** (noted inline, matching the Page Shield → Client-side security rename convention). Available on all plans including Free. Confirmed against Cloudflare's redirect-rules API docs and a live write.

## [0.4.2] - 2026-07-06

### Changed
- **Raised the `Zone` permission group from `Read` to `Edit` in `references/token-model.md`.** Attaching a custom domain to a Worker performs zone edits, which fail with only `Zone: Read` — the combined token now grants `Zone: Edit` (zone/plan discovery is still covered, since `Edit` implies `Read`). The read-only audit-token recipe in §4 is unchanged and stays `Zone: Read`.

## [0.4.1] - 2026-07-06

### Fixed
- **Removed a non-existent token permission row from `references/token-model.md`.** The combined-token table listed `User | Workers Scripts | Read`, but Cloudflare's **User** scope only exposes API Tokens, Memberships, and User Details — "Workers Scripts" is an **Account**-scoped group with no user-scoped variant, so that row was not selectable in the dashboard. The Builds "retrieve the Worker's tag" read it was meant to cover is already provided by the existing `Account | Workers Scripts | Edit` grant (`Edit` implies `Read`), so no replacement permission is needed. Folded that rationale into the Account row. Confirmed against Cloudflare's API-token permissions reference and the `/user/tokens/permission_groups` scope model.

## [0.4.0] - 2026-07-06

### Added
- **Wire the token manual as a post-install `setupGuide`.** The `CLOUDFLARE_API_TOKEN` env entry now declares `setupGuide: references/token-model.md` and a `verify` command. On a CLI with support, installing the skill without the token set surfaces a `complete_manual_setup` next_step pointing at the manual, so the agent guides the user through creating the token — instead of leaving a bare "secret not set" warning. (Forward-compatible: CLIs without support ignore the new fields.)

## [0.3.1] - 2026-07-06

### Changed
- **Add explicit in-dashboard navigation to the token walkthrough** (`references/token-model.md` §2). Step 1 now spells out how to reach the API Tokens page from a logged-in dashboard — the top-right profile/account icon → **My Profile** → **API Tokens** tab — with the direct URL kept as the durable shortcut, and an explicit warning to use **My Profile → API Tokens** (user-owned) not **Manage Account → API Tokens** (account-owned, which the constellation cannot use). Menu labels verified against Cloudflare's official create-token docs.

## [0.3.0] - 2026-07-06

### Added
- **Exhaustive API-token setup manual in `references/token-model.md`.** Rewrote the token reference into a complete guide: where to create the token (dashboard walkthrough — My Profile → API Tokens, Create Custom Token, resource scoping, copy-once), and the **single combined permission set for 100% of the constellation's API surface**. Research-verified against Cloudflare's primary docs. New facts captured: the **`Workers CI` / "Workers Builds Configuration": Edit** permission (the previously-missing row for the native Workers Builds API); the requirement that the token be **user-owned, not account-owned** (Workers Builds + Super Bot Fight Mode reject account-owned tokens); `Edit` implies `Read` (CRUDL); the **Page Shield → "Client-side security"** rename; and that permission-group names are cosmetic (match by `id` via live `/user/tokens/permission_groups`). Deploy Hooks need no token; the GitHub App install is the only dashboard step.

## [0.2.0] - 2026-07-06

### Added
- `sharedEnv: true` — the constellation now shares a single `./secrets/cloudflare.env` across the core and its `cloudflare-deploy` / `cloudflare-config` satellites on install, instead of three identical per-skill secret files. One `CLOUDFLARE_API_TOKEN` to set and rotate. (Requires a CLI with shared-env support; older CLIs safely fall back to per-skill files.)

## [0.1.0] - 2026-07-06

### Added
- Initial release. Read-only Cloudflare account operations: audit HTTP traffic and Workers usage via the GraphQL Analytics API, monitor Workers consumption/cost, verify API token scopes, and read DNS/zone/security config through a token-hiding `cf.js` wrapper. Core of the Cloudflare constellation; bundles `cloudflare-deploy` and `cloudflare-config` as dependencies.
