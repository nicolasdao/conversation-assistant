# Changelog

All notable changes to this skill are documented here.

## [0.1.2] - 2026-07-06

### Fixed
- **Corrected the token scope in `references/workers-builds-api.md` §1.** It stated the Builds "retrieve the Worker's tag" endpoint needs `Workers Scripts: Read` **at User scope** — but Cloudflare's User scope only offers API Tokens, Memberships, and User Details; "Workers Scripts" is **Account**-scoped. That read is already covered by the combined token's `Account | Workers Scripts | Edit` grant (`Edit` implies `Read`), so no extra permission is required. Also reworded the §1 header from "USER-scoped" to "user-owned token" to keep token *ownership* distinct from a "User" permission scope.

## [0.1.1] - 2026-07-06

### Added
- **Document the Workers Builds API token requirement** in `references/workers-builds-api.md` (new §1). The native Builds API requires a **user-owned** API token (account-owned tokens are rejected with `Invalid token`) carrying the **`Workers CI` / "Workers Builds Configuration": Edit** permission, plus `Workers Scripts: Read` at User scope for one endpoint. Points to the core skill's `token-model.md` for the full permission set and creation walkthrough.

## [0.1.0] - 2026-07-06

### Added
- Initial release. Deploy Cloudflare Workers and set up CI/CD: one-off `wrangler deploy`, build-on-push via GitHub Actions (`wrangler-action@v3`) or the native Workers Builds REST API (branch/path triggers, build/deploy commands, env vars), Deploy Hooks, and the GitLab CI equivalent. Satellite of the Cloudflare constellation.
