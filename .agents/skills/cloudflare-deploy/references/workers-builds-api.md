# Route B — Native Workers Builds REST API (config-as-code)

Cloudflare's own build pipeline, driven by API instead of dashboard clicks. As
of 2026 the old "Workers Builds is dashboard-only" limitation is **false**: there
is an official REST API under `/accounts/{account_id}/builds/...`.
(Verified July 2026; the API landed in Jan 2026 and was still maturing through
early 2026 — re-check the docs for new fields.)

## 1. Token requirement — user-owned token, `Workers CI: Edit`

The Builds API has a non-obvious auth requirement most other Cloudflare APIs
don't: **it requires a user-owned API token.** Account-owned tokens are rejected
with `Invalid token` (account support is documented as "coming soon"). So the
token must be a **Custom Token created under My Profile → API Tokens** (user-owned
by default), NOT under Manage Account → API Tokens.

The permission group is **`Workers CI`** (Account scope, **Edit**) — Cloudflare's
Builds API-reference page calls the same group **"Workers Builds Configuration:
Edit"**; they're the same thing (names are cosmetic — match by `id`). One endpoint
(retrieving the Worker's tag) additionally needs **`Workers Scripts: Read` at
Account scope** — already covered by the combined token's Account-scope
`Workers Scripts: Edit` grant (`Edit` implies `Read`). (Note: "user-owned token"
above refers to token *ownership*, not a "User" permission scope — Cloudflare's
User scope only offers API Tokens, Memberships, and User Details.) The full
permission set, and how to create the token, is in the core
skill's [`references/token-model.md`](../../cloudflare/references/token-model.md).

## 2. The one manual prerequisite

**Install the Cloudflare GitHub App through the dashboard, once.** This is the
only step with no API. It produces the `repo_connection_uuid` that the trigger
API consumes. Verbatim from Cloudflare's API reference: *"Before using the API,
you must first install the Cloudflare GitHub App through the dashboard,"* then
*"you can use the API for everything else."* (There is an open feature request to
make this step scriptable; until then it's a manual gate. The
`gitlab`/`gitlab_internal` providers have an analogous install.)

## 3. The endpoint family

All under `https://api.cloudflare.com/client/v4/accounts/{account_id}/builds/...`,
authenticated with the scoped **config** token (Bearer). Cloudflare's response
envelope is `{success, errors, messages, result, result_info}`.

| Operation | Endpoint |
|---|---|
| Upsert a Git repo connection (providers: `github` / `gitlab` / `gitlab_internal`) | `PUT /builds/repos/connections` |
| Create a build trigger | `POST /builds/triggers` |
| Update / delete a trigger | `PATCH` / `DELETE /builds/triggers/{uuid}` |
| Manage build-time env vars (production vs preview) | `PATCH .../environment_variables` |
| Trigger a manual build | `POST /builds` |
| Read build status / logs | `GET /builds/...` |
| Cancel a running build | `PUT .../cancel` |

### Trigger fields (build-on-push config)

`POST /builds/triggers` accepts:

- `repo_connection_uuid` — links to the connection from the manual install
- `branch_includes` / `branch_excludes` — **this is the branch filter that makes
  it build-on-push** (e.g. `branch_includes: ["main"]` for your default branch)
- `path_includes` / `path_excludes` — only build when matching paths change
- `root_directory` — monorepo subdir
- `build_command` / `deploy_command` — the two-step build then deploy

On push to a connected branch, Workers Builds runs build → deploy automatically.
The listened branch defaults to `main` if unset; set `branch_includes` to
control it.

## 4. Known caveat — trigger endpoint bug

An open Cloudflare docs issue reports `POST /builds/triggers` returning
**HTTP 400 `[12002]`** on otherwise-valid requests. If you hit it, the documented
working fallbacks are:

- the `PUT` upsert path for the connection, and/or
- **Deploy Hooks** (see the main SKILL.md §5) as the build trigger.

Confirm the endpoint works in a throwaway test before wiring it into anything
load-bearing.

## 5. When to choose this over Route A (GitHub Actions)

Choose native Workers Builds when you want Cloudflare's build UI, build logs in
the dashboard, and preview deployments managed by Cloudflare — and you're willing
to do the one-time GitHub App install. Choose Route A (GitHub Actions) when you
want zero dashboard steps and portable, repo-versioned CI. Both end at the same
place: a Worker that redeploys on push to your default branch.
