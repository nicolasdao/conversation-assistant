---
name: cloudflare
description: Cloudflare — Audit and monitor a Cloudflare account read-only. Use when checking traffic or Workers usage, investigating a bot spike, watching the Workers bill, or verifying API token scopes. Not for deploying Workers or editing DNS/WAF/zone config.
---

# Cloudflare — Account Operations (read-only)

The entry point for operating a Cloudflare account programmatically. This skill
owns the **shared foundation** the whole Cloudflare constellation stands on —
the one scoped API token, the secret-hygiene contract, and the read-only
`cf.js` access wrapper — plus every **read-only** operation: auditing HTTP
traffic, auditing Workers usage, monitoring cost/consumption, and verifying
token scopes.

**Scope boundary:** this constellation operates the **Cloudflare** account only
(the zone, its Workers, DNS, and security config). An application backend hosted
elsewhere — e.g. on AWS Lambda / CloudFront — is **not** Cloudflare and is out of
scope here, even if it serves the same product.

Writes live in sibling skills. This skill never mutates the account.

## Section 1 — Routing

| User intent | Handle here? | Where |
|---|---|---|
| "How much traffic did we get?", "request counts", "bytes served" | ✅ | [§4 Audit HTTP traffic](#4-audit-http-traffic) |
| "Workers invocations / CPU / errors", "which script is busiest" | ✅ | [§5 Audit Workers usage](#5-audit-workers-usage) |
| "Is a bot hammering us?", "who is crawling a path", bot-category breakdown | ✅ | [§5 + GraphQL recipes](references/graphql-recipes.md) |
| "Is the Workers bill spiking?", consumption monitoring | ✅ | [§6 Monitor cost](#6-monitor-costconsumption) |
| "How do I get / create the API token?", "which permissions does it need?", verify/scope a token | ✅ | [references/token-model.md](references/token-model.md) — full setup manual (dashboard walkthrough + the exact permission rows for 100% of the surface) |
| "What plan are we on?", account/zone/cost summary | ✅ | [§3 Account, plan, cost](#3-account-plan-and-cost) |
| Read a DNS record or a zone setting (GET) | ✅ | [§7 Read config](#7-read-config-get-only) |
| Read the exact dollar amount billed | ⚠️ dashboard-only | [§8 Billing limitation](#8-billing--a-known-limitation) |

### What NOT to handle here (redirect)

| Intent | Owner | Redirect phrase |
|---|---|---|
| Deploy a Worker, `wrangler deploy`, set up build-on-push, Workers Builds, deploy hooks, GitHub Actions | **cloudflare-deploy** | "deploy a Worker" / "set up CI on push" |
| **Change** DNS records, write a WAF rule, edit zone/SSL/TLS/bot-management settings | **cloudflare-config** | "add a DNS record" / "write a WAF rule" |

The seam to watch: this skill **reads** DNS/zone settings via `cf.js rest GET`;
**changing** any of them belongs to `cloudflare-config`. Read vs write is the
disambiguator — if the user wants to modify anything, stop and route.

## Section 2 — The credential and the wrapper

### 2.1 One token, three interfaces

A single scoped **API token** (Bearer auth) authenticates all three Cloudflare
surfaces — there is one credential, not three auth systems:

```
                    ┌─ GraphQL  /client/v4/graphql      → analytics: traffic + Workers usage (READ)
ONE Bearer token ───┼─ wrangler (CLOUDFLARE_API_TOKEN)  → Workers deploy/provision/secrets/routes (WRITE — cloudflare-deploy)
                    └─ REST     /client/v4/...           → DNS + security config (READ here / WRITE in cloudflare-config)
```

This skill uses only the **read** paths (GraphQL + REST GET), but the token is
shared across the whole constellation. **How to create the token, where to get
it, and the exact permissions to grant for 100% of the constellation's API
surface** — including the user-scoped-token requirement for Workers Builds — is
the full manual in [references/token-model.md](references/token-model.md).

### 2.2 Configuration and secret handling

This skill declares its secret in `skill.json` (per the HappySkills config
contract), so setup lives **outside** the skill in the project's
`skills-config.json` / `.env`, never inside the skill folder. The one declared
value is **`env` (secret): `CLOUDFLARE_API_TOKEN`** — the scoped Bearer token,
required. `secret: true` routes it to a gitignored `.env`; its value never lands
in any committed file. `wrangler` reads this same name natively, so there is one
secret across the whole constellation. Zone/account IDs are **not** config —
they are discovered at runtime via [§3](#3-account-plan-and-cost).

> **Resolve configuration before using any default — there is one correct way; follow it, don't improvise.** Prefer `happyskills skills-config get nicolasdao/cloudflare --json`: it returns the merged non-secret `config`, the resolved `envFile`, the required-secret names, and a present/absent flag. If the CLI is unavailable, do the **same** resolution by hand, in this exact order:
>
> 1. **Find the project root.** Search upward from your current directory for the nearest `skills-config.json` or `skills-lock.json`, stopping at a `.git` boundary. That directory is the project root.
> 2. **Read the config.** In that project root, read `skills-config.json` (then the global `~/.agents/skills-config.json`) under the key `nicolasdao/cloudflare`. Anything unset falls back to this skill's hardcoded defaults.
> 3. **Resolve `envFile` against the directory of the `skills-config.json` that declared it — NOT your current directory.** Use the project file's `envFile` if it declares one; otherwise the global file's. The `envFile` value (e.g. `./secrets/x.env`) is relative to the directory holding the `skills-config.json` it came from: a value from the project file resolves against the project root (step 1); a value from the global `~/.agents/skills-config.json` resolves against `~/.agents`. Join it to that directory to get the real path — never to the directory you happen to be running from. **This is the one step that is easy to get wrong: resolving it against your current working directory makes the skill work from the project root but fail from any subdirectory. Anchor it to the declaring config file's own directory and it works from anywhere.**
> 4. **Load secrets** from the resolved `envFile` — but an ambient environment variable of the same name takes precedence over the file.
> 5. If a required secret is missing, **STOP** and tell the user exactly which variable to set and in which file.

If your project's `skills-config.json` has no `nicolasdao/cloudflare` entry yet
(e.g. before you've configured the skill), `skills-config get` returns nothing —
`cf.js` then reads the token from the environment or a project-root `.env`
directly (§2.3).

The token must **never** be printed to stdout, a command line, an error message,
or an agent's context window:

- Reach the token only through `cf.js` (below). Never `cat`/`grep`/`echo` the `.env`.
- To confirm the token is configured without revealing it, run the verify in
  [§7](#7-read-config-get-only) (`cf.js rest GET "/user/tokens/verify"`) — it
  reports the token's status and never prints the value. Do **not** rely on
  `'CLOUDFLARE_API_TOKEN' in process.env`: the token normally lives in `.env`
  (unexported), so that check reads `false` even when it is correctly set.

### 2.3 `cf.js` — the read-only access wrapper

[`scripts/cf.js`](scripts/cf.js) loads the token inside its own process, calls
the GraphQL or REST API, and prints only the JSON result — the token is never
exposed. It is **read-only by design**: REST is restricted to `GET`, and the
GraphQL Analytics API has no mutations.

`cf.js` is **bundled with this skill**. In the examples below, `scripts/cf.js`
is the path *relative to this skill's own directory* — run the commands from
this skill's directory, or substitute the skill's absolute path
(`node <this-skill-dir>/scripts/cf.js …`). It is not a path under the project
root, so `node scripts/cf.js` from the repo root will not find it.

```bash
# REST GET (zone discovery, DNS reads, security-setting reads)
node scripts/cf.js rest GET "/zones?name=<your-zone>"
node scripts/cf.js rest GET "/zones/$ZONE_ID/settings"

# GraphQL analytics (query + optional variables JSON)
node scripts/cf.js graphql '<query>' '<variablesJson>'
```

The wrapper exits non-zero on HTTP errors and on GraphQL query errors (which
return HTTP 200 but carry an `errors[]` array), so failures are detectable in a
pipeline. Errors are printed without the token or the auth header.

Token setup: the token comes from `skills-config.json` / `.env` per §2.2. `cf.js`
checks the environment first (`CLOUDFLARE_API_TOKEN`), then **walks up from the
working directory** for a `.env` — so running from this skill's directory (which
sits under the project) finds the project-root `.env` automatically. All it needs
is a project-root `.env`; where you run it from does not matter.

## Section 3 — Account, plan, and cost

Discover the live account ID, zone ID, and plan tier at any time (read-only):

```bash
node scripts/cf.js rest GET "/zones?name=<your-zone>"
# -> result[0].id (zone id), result[0].account.id, result[0].plan.legacy_id
```

The bill spans three independent layers, each billing on a different basis. Read
your account's actual tiers from the plan discovery above rather than assuming:

| Layer | Attached to | Pays for | Billing model |
|---|---|---|---|
| **Zone plan** (Free / Pro / Business / Enterprise) | the domain (zone) | CDN, caching, WAF managed rules, Super Bot Fight Mode, SSL, analytics | Flat per tier (Free = $0) — unmetered by traffic |
| **Workers** (Free or Paid) | the account (compute) | running Workers + bindings (Paid includes 10M req + 30M CPU-ms/month) | Free tier with a daily cap, or Paid base fee + metered overage |
| **Images / Stream** | the account (media) | storing & delivering images/video | Pure usage (often dormant, $0) |

Key consequences:

- **Static asset requests are free and unmetered** and don't invoke the Worker.
  You're billed (as Worker invocations) only for **dynamic** work plus bots
  crawling dynamic URLs.
- **The lever most likely to move the bill is Workers consumption** — the zone
  plan is a flat per-tier fee, media is usually dormant. That is the one number
  worth monitoring ([§6](#6-monitor-costconsumption)).
- **Workers Paid vs Free is bot-spike insurance, not render cost.** The Free tier
  caps at **100k requests/day**; on a crawler-spike day the Worker would hit that
  cap and start erroring. The Paid base fee removes the daily cap — so it buys
  resilience against a bot spike, not page-rendering capacity ([§6](#6-monitor-costconsumption)).
- Several features are **Enterprise-only** — Bot Management *score*
  (`cf.bot_management.score`), account-level WAF, and Page Shield *policies*. On
  any sub-Enterprise plan (Free / Pro / Business) a call that depends on them is
  rejected — check the discovered plan tier before relying on them.

## Section 4 — Audit HTTP traffic

Daily request count + bytes for a zone. Replace `<ZONE_ID>` with the value from
§3; dates are RFC3339 UTC strings.

```bash
node scripts/cf.js graphql \
  'query($zone:string!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:100,filter:{datetime_geq:$start,datetime_leq:$end}){count sum{edgeResponseBytes} dimensions{date}}}}}' \
  '{"zone":"<ZONE_ID>","start":"2026-05-27T00:00:00Z","end":"2026-06-03T23:59:59Z"}'
```

The request count is the top-level **`count`** (NOT `requests`); bytes live under
`sum { edgeResponseBytes }`. See [references/graphql-recipes.md](references/graphql-recipes.md)
for the naming traps that will otherwise cost you a build cycle.

## Section 5 — Audit Workers usage

Per-script invocations, errors, subrequests, and CPU-time percentiles for an
account. This node is **account-scoped** (`viewer.accounts`, not `.zones`):

```bash
node scripts/cf.js graphql \
  'query($acct:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$acct}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$start,datetime_leq:$end}){sum{requests errors subrequests} quantiles{cpuTimeP50 cpuTimeP99} dimensions{scriptName}}}}}' \
  '{"acct":"<ACCOUNT_ID>","start":"2026-05-27T00:00:00Z","end":"2026-06-03T23:59:59Z"}'
```

Note the field-placement difference from HTTP: for Workers the request count is
`sum { requests }` and CPU is `quantiles { cpuTimeP50/P99 }`. Add a `date`
dimension for a daily time series. The node allows up to one month per query,
for dates up to three months back.

For bot-category breakdowns (e.g. "who is crawling us?"), see the
`verifiedBotCategory` recipe and taxonomy trap in
[references/graphql-recipes.md](references/graphql-recipes.md) — Applebot lives
under `"AI Search"`, not `"Search Engine Crawler"`.

> **Usage, not dollars.** GraphQL returns usage counts; Cloudflare explicitly
> warns these are not the billed numbers. Use them for trend/estimation; read
> authoritative charges from the dashboard ([§8](#8-billing--a-known-limitation)).

## Section 6 — Monitor cost/consumption

Because Workers consumption is the only variable that moves the bill, the
highest-value monitoring is a Workers-invocation trend with spike detection:

1. Pull daily Workers invocations (the §5 query with a `date` dimension).
2. Compare each day against the trailing baseline (e.g. the prior 7-day median).
3. Flag any day that jumps ≥5× over baseline — that is the shape of a crawler
   incident (a single bot-spike day can push a small zone past several hundred
   thousand invocations).

This is read-only trend estimation. It does not read dollars — see §8.

## Section 7 — Read config (GET only)

`cf.js rest GET` reads DNS records and security settings for inventory/audit:

```bash
node scripts/cf.js rest GET "/zones/$ZONE_ID/dns_records"
node scripts/cf.js rest GET "/zones/$ZONE_ID/settings"
node scripts/cf.js rest GET "/user/tokens/verify"   # verify the current token
```

**Security inventory** — to enumerate which security features are enabled,
available, or Enterprise-locked on your plan, GET the security surfaces
read-only and inspect what each returns:

```bash
node scripts/cf.js rest GET "/zones/$ZONE_ID/settings"          # SSL/TLS, HSTS, always-HTTPS, etc.
node scripts/cf.js rest GET "/zones/$ZONE_ID/rulesets"          # WAF + rate-limit rulesets
node scripts/cf.js rest GET "/zones/$ZONE_ID/bot_management"    # Super Bot Fight Mode / Bot Management
node scripts/cf.js rest GET "/zones/$ZONE_ID/page_shield"       # Page Shield status
```

On any sub-Enterprise plan, the Enterprise-only surfaces (Bot Management *score*,
Page Shield *policies*) return a restricted/empty result rather than the full
feature — that absence is itself the inventory signal (see [§3](#3-account-plan-and-cost)).

**Reading** is in scope here. **Changing** any of these is `cloudflare-config`'s
job — route there the moment the user wants to add, edit, or delete anything.

## Section 8 — Billing — a known limitation

**Cloudflare's billing/subscription endpoints reject scoped API tokens** — every
one (`/zones/{id}/subscription`, `/accounts/{id}/subscriptions`,
`/user/billing/*`, …) returns `code 10000` ("Authentication error"), regardless
of whether `Billing: Read` is attached. Only the legacy Global API Key works,
and that key is root-equivalent — do **not** add it just to read a number.

The dashboard (Account Home → **Billing → Subscriptions**) is the authoritative
source for exact dollars and the active plan. Drop `Billing: Read` from tokens
for least-privilege — it grants no working capability here.

## Section 9 — Constraints

- **Read-only.** This skill never mutates the account. REST is GET-only; GraphQL
  has no mutations. Any write intent → route to `cloudflare-config` (DNS/WAF/zone)
  or `cloudflare-deploy` (Workers/CI).
- **Never expose the token.** No `cat`/`grep`/`echo` of `.env`; presence-only
  probes; the token never enters stdout or the context window.
- **`cf.js` is bundled in this skill** (`scripts/cf.js` is relative to the skill
  directory, not the repo root). It finds the project-root `.env` by walking up
  from the working directory, so a project-root `.env` is all it needs.
- **Introspect before non-trivial GraphQL.** Analytics fields are plan-gated;
  see [references/graphql-recipes.md](references/graphql-recipes.md).
