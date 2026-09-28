---
name: cloudflare-deploy
description: Cloudflare — Deploy Workers and set up CI/CD. Use when deploying a Worker, wiring build-on-push via GitHub Actions or Workers Builds, or adding deploy hooks. Not for account analytics or DNS/WAF/zone config.
---

# Cloudflare — Workers Deploy & CI/CD

Everything about getting a Worker live and keeping it live: one-off deploys with
`wrangler`, and three programmatic routes to **build-on-push** — none
of which requires clicking through the dashboard for the deploy itself.

Depends on the **cloudflare** core skill for the token/secret model. Reads and
audits (traffic, Workers usage) belong there, not here.

## Section 1 — Routing

| User intent | Where |
|---|---|
| "Deploy this Worker", one-off ship | [§3 wrangler deploy](#3-one-off-deploy--wrangler) |
| "Build/deploy on push" (to your default branch), set up CI | [§4 Pick a CI route](#4-choose-a-ci-route) |
| "GitHub Actions to deploy the Worker" | [references/github-actions.md](references/github-actions.md) |
| "Use Cloudflare's own Git integration / Workers Builds", config-as-code triggers | [references/workers-builds-api.md](references/workers-builds-api.md) |
| "Trigger a build from a cron/CMS/webhook", deploy hooks | [§5 Deploy Hooks](#5-deploy-hooks) |
| "Can we do this in Terraform/Pulumi?" | [§6 Not available](#6-what-is-not-available) |

### What NOT to handle here (redirect)

| Intent | Owner | Redirect phrase |
|---|---|---|
| Check traffic / Workers usage / bot spikes / the bill / token scopes | **cloudflare** (core) | "audit our Workers usage" |
| **Change** DNS records, WAF rules, zone/SSL/bot-management settings | **cloudflare-config** | "add a DNS record" / "write a WAF rule" |

Note: a Worker often needs a **route** or **custom domain** to serve traffic.
Setting a Worker *route* is part of deploying and lives here (wrangler config).
Editing the underlying *DNS record* is `cloudflare-config`.

## Section 2 — The credential

This skill declares its environment contract in `skill.json`: **`env`**
`CLOUDFLARE_API_TOKEN` (required, secret) and `CLOUDFLARE_ACCOUNT_ID` (required
false, non-secret — `wrangler` reads both names natively). Setup lives in the
project's `skills-config.json` / `.env`, never in the skill folder.

> **Resolve configuration before using any default — there is one correct way; follow it, don't improvise.** Prefer `happyskills skills-config get nicolasdao/cloudflare-deploy --json`: it returns the merged non-secret `config`, the resolved `envFile`, the required-secret names, and a present/absent flag. If the CLI is unavailable, do the **same** resolution by hand, in this exact order:
>
> 1. **Find the project root.** Search upward from your current directory for the nearest `skills-config.json` or `skills-lock.json`, stopping at a `.git` boundary. That directory is the project root.
> 2. **Read the config.** In that project root, read `skills-config.json` (then the global `~/.agents/skills-config.json`) under the key `nicolasdao/cloudflare-deploy`. Anything unset falls back to this skill's hardcoded defaults.
> 3. **Resolve `envFile` against the directory of the `skills-config.json` that declared it — NOT your current directory.** Use the project file's `envFile` if it declares one; otherwise the global file's. The `envFile` value (e.g. `./secrets/x.env`) is relative to the directory holding the `skills-config.json` it came from: a value from the project file resolves against the project root (step 1); a value from the global `~/.agents/skills-config.json` resolves against `~/.agents`. Join it to that directory to get the real path — never to the directory you happen to be running from. **This is the one step that is easy to get wrong: resolving it against your current working directory makes the skill work from the project root but fail from any subdirectory. Anchor it to the declaring config file's own directory and it works from anywhere.**
> 4. **Load secrets** from the resolved `envFile` — but an ambient environment variable of the same name takes precedence over the file.
> 5. If a required secret is missing, **STOP** and tell the user exactly which variable to set and in which file.

If your project's `skills-config.json` has no `nicolasdao/cloudflare-deploy`
entry yet, `skills-config get` returns nothing — supply `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` via the environment or a project-root `.env`.

Deploys need the read-write **config** token scopes (Workers Scripts: Edit,
Workers Routes: Edit) — see the core skill's `references/token-model.md`. Never
print the token; never ship it to the browser or an edge Worker.

## Section 3 — One-off deploy — `wrangler`

```bash
CLOUDFLARE_API_TOKEN=$CF_TOKEN CLOUDFLARE_ACCOUNT_ID=$CF_ACCT npx wrangler deploy
```

`wrangler deploy` reads `wrangler.toml`/`wrangler.jsonc` for the script name,
routes, custom domains, bindings, and vars. Runtime secrets go through
`wrangler secret put <NAME>` (never commit them). This is the primitive every CI
route below ultimately calls.

## Section 4 — Choose a CI route

Three programmatic ways to get build-on-push. Pick by how much you want to live
inside Cloudflare vs your own CI:

| Route | Dashboard steps | Best when |
|---|---|---|
| **A. GitHub Actions + `wrangler-action`** | **none** | You want zero dashboard steps and CI-as-code in your repo. **Recommended default.** |
| **B. Workers Builds REST API** (native) | one-time GitHub App install | You want Cloudflare's own build pipeline, configured as code |
| **C. Deploy Hooks** | (needs a Worker/branch to target) | You want to trigger a build from a non-git source (cron, CMS, webhook) |

> **The "dashboard-only, no API" belief is outdated.** Cloudflare shipped an
> official Workers Builds REST API (issue closed COMPLETED Jan 23 2026) and
> Deploy Hooks for Workers Builds (2026-04-01). Verified July 2026. The only
> genuinely manual step in the *native* path is a one-time GitHub App OAuth
> install; everything after it is scriptable.

### Route A — GitHub Actions (recommended, zero dashboard)

The canonical dashboard-free path. Trigger on push to your branch and run
`cloudflare/wrangler-action@v3` (which runs `wrangler deploy` by default). Needs
only `CLOUDFLARE_API_TOKEN` (and account ID) as GitHub secrets — no Cloudflare
GitHub App, no Git integration. Full workflow YAML, secrets, token scopes, and
the GitLab CI equivalent: **[references/github-actions.md](references/github-actions.md)**.

### Route B — Native Workers Builds (config-as-code)

Cloudflare's own CI. One manual prerequisite (install the Cloudflare GitHub App
via the dashboard, which mints a `repo_connection_uuid`), then the entire
pipeline is API-driven: upsert the repo connection, create a trigger with
branch/path filters and build/deploy commands, manage build-time env vars,
trigger manual builds, read logs. Full endpoint family and the known
trigger-endpoint bug: **[references/workers-builds-api.md](references/workers-builds-api.md)**.

## Section 5 — Deploy Hooks

Each hook is a unique URL tied to a specific branch; POST to it and that branch
builds + deploys. **No `Authorization` header** — the ID embedded in the URL is
the credential, so treat the URL as a secret. Rate-limited to 10 builds/min/Worker
and 100 builds/min/account.

```bash
curl -X POST "https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<DEPLOY_HOOK_ID>"
```

This gives a programmatic push-to-build trigger from any HTTP source — a cron
trigger, a headless CMS, a Slack bot, another CI system. It mirrors the
long-standing Cloudflare Pages deploy-hook capability (the Pages-vs-Workers gap
on this closed in April 2026).

## Section 6 — What is NOT available

- **Terraform / Pulumi:** no provider resource for Workers Builds / Git
  integration / build triggers as of this writing. IaC-as-code for the *build
  pipeline* specifically is not yet possible (you can still manage the Worker
  script/routes via the provider, just not the Builds Git integration). Track
  the provider changelog before assuming otherwise.
- **The one-time GitHub App OAuth install** (Route B) is dashboard-only — there
  is no API to create the GitHub App connection itself. Everything after the
  install is scriptable.
- **Billing reads** — dashboard-only (see the core skill).

## Section 7 — Constraints

- **Deploys are writes.** Confirm before shipping to a live account. Prefer the
  config token with least-privilege scopes; rotate after use.
- **Never expose the token** — not in logs, not in the browser, not in an edge
  Worker. Map the one secret to `CLOUDFLARE_API_TOKEN` at the call boundary.
- **Deploy-hook URLs are credentials** — store them as secrets, never commit.
- **Verify the Terraform/Deploy-Hooks/API facts before relying on them** — this
  surface moved fast in 2026 (native API and deploy hooks both shipped that
  year). Re-check the changelog if precision matters.
- Reads/audits are **not** here — route to the `cloudflare` core skill.
