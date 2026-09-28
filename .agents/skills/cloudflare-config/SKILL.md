---
name: cloudflare-config
description: Cloudflare — Configure DNS, WAF, and zone security via REST. Use when adding DNS records, writing WAF rules, or changing SSL/TLS, bot management, or zone settings. Not for reading analytics or deploying Workers.
---

# Cloudflare — Account Configuration (writes)

Changing the account's DNS records and security posture through the Cloudflare
REST API: DNS records, WAF rulesets, rate limiting, zone settings (SSL/TLS,
HSTS), Super Bot Fight Mode, Page Shield, Bot Management. Every operation here is
a **write** to a live account — treat each as one-way until confirmed.

Depends on the **cloudflare** core skill for the token/secret model. **Reading**
DNS/zone settings belongs to core; this skill is for **changing** them.

## Section 1 — Routing

| User intent | Where |
|---|---|
| "Add / edit / delete a DNS record" | [§3 DNS](#3-dns-records) + [references/rest-write-endpoints.md](references/rest-write-endpoints.md) |
| "Write / change a WAF rule", block or challenge traffic | [§4 WAF & security](#4-waf-and-security-config) |
| "Change SSL/TLS mode, HSTS, a zone setting" | [§4 + endpoints reference](references/rest-write-endpoints.md) |
| "Turn on Super Bot Fight Mode / Bot Management / Page Shield" | [§4](#4-waf-and-security-config) |
| "Rate-limit a path" | [references/rest-write-endpoints.md](references/rest-write-endpoints.md) |

### What NOT to handle here (redirect)

| Intent | Owner | Redirect phrase |
|---|---|---|
| **Read** traffic, Workers usage, bot spikes, the bill; **read** a DNS record or zone setting; verify a token | **cloudflare** (core) | "audit our traffic" / "read the zone settings" |
| Deploy a Worker, set up CI, Workers Builds, deploy hooks, Worker routes | **cloudflare-deploy** | "deploy a Worker" / "set up CI" |

The seam with core: core does `cf.js rest GET` (read); this skill does REST
`POST`/`PUT`/`PATCH`/`DELETE` (write). If the user only wants to *see* current
config, that's core — route there and don't make a change.

## Section 2 — The credential and the missing wrapper

Writes authenticate with the same one scoped token, but need the read-write
**config** token scopes matching what you touch — `DNS: Edit`, `Zone WAF: Edit`,
`Firewall Services: Edit`, `Zone Settings: Edit`, `SSL and Certificates: Edit`,
`Bot Management: Edit`, `Page Shield: Edit` (full table in the core skill's
`references/token-model.md`). Treat the config token as the dangerous one: short
expiry, rotate after use.

> **There is no bundled write wrapper.** The core skill's `cf.js` is **read-only
> by design** (REST restricted to GET). Writes are done with `curl` (or `wrangler`
> for Workers) against the REST API directly, with the token supplied via an env
> var — never on the command line, never printed. A confirm-before-apply
> write-capable wrapper is a roadmap item; until it exists, apply the discipline
> in §5 by hand on every write.

This skill declares its secret in `skill.json`: **`env`** `CLOUDFLARE_API_TOKEN`
(required, secret). Setup lives in the project's `skills-config.json` / `.env`,
never in the skill folder. Zone IDs are **not** config — read them at write time
via the **cloudflare** core skill.

> **Resolve configuration before using any default — there is one correct way; follow it, don't improvise.** Prefer `happyskills skills-config get nicolasdao/cloudflare-config --json`: it returns the merged non-secret `config`, the resolved `envFile`, the required-secret names, and a present/absent flag. If the CLI is unavailable, do the **same** resolution by hand, in this exact order:
>
> 1. **Find the project root.** Search upward from your current directory for the nearest `skills-config.json` or `skills-lock.json`, stopping at a `.git` boundary. That directory is the project root.
> 2. **Read the config.** In that project root, read `skills-config.json` (then the global `~/.agents/skills-config.json`) under the key `nicolasdao/cloudflare-config`. Anything unset falls back to this skill's hardcoded defaults.
> 3. **Resolve `envFile` against the directory of the `skills-config.json` that declared it — NOT your current directory.** Use the project file's `envFile` if it declares one; otherwise the global file's. The `envFile` value (e.g. `./secrets/x.env`) is relative to the directory holding the `skills-config.json` it came from: a value from the project file resolves against the project root (step 1); a value from the global `~/.agents/skills-config.json` resolves against `~/.agents`. Join it to that directory to get the real path — never to the directory you happen to be running from. **This is the one step that is easy to get wrong: resolving it against your current working directory makes the skill work from the project root but fail from any subdirectory. Anchor it to the declaring config file's own directory and it works from anywhere.**
> 4. **Load secrets** from the resolved `envFile` — but an ambient environment variable of the same name takes precedence over the file.
> 5. If a required secret is missing, **STOP** and tell the user exactly which variable to set and in which file.

If your project's `skills-config.json` has no `nicolasdao/cloudflare-config`
entry yet, `skills-config get` returns nothing — supply `CLOUDFLARE_API_TOKEN`
via the environment or a project-root `.env`.

Cloudflare's REST envelope is `{success, errors, messages, result, result_info}`
— if you wrap these calls behind your own API, translate it to your own response
format at that boundary. Global REST rate limit: 1,200 requests / 5 min.

## Section 3 — DNS records

DNS is the most common write. List first (read via the **cloudflare** core
skill) to get the `record_id`, then create/update/delete:

```bash
# Create — the token is piped via `curl --config` so it never lands in curl's
# argv (i.e. never visible in `ps`); printf is a shell builtin, so it is not in
# any external process's argument list either.
printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | \
curl -sS --config - -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Content-Type: application/json" \
  --data '{"type":"A","name":"sub.example.com","content":"203.0.113.10","proxied":true}'
```

That `printf … | curl --config -` pattern is how **every** write below should
send the token — never `-H "Authorization: Bearer $TOKEN"` directly, which
expands the token into curl's command line.

Full CRUD shapes (POST/PUT/PATCH/DELETE) and the proxied-vs-DNS-only nuance are
in [references/rest-write-endpoints.md](references/rest-write-endpoints.md).

## Section 4 — WAF and security config

Security config spans several endpoint families — WAF custom rulesets, rate
limiting, zone settings (SSL/TLS, HSTS), Super Bot Fight Mode, Page Shield, Bot
Management. All are REST writes with the matching config-token scope. Endpoint
paths, ruleset phrasing, and examples: [references/rest-write-endpoints.md](references/rest-write-endpoints.md).

**Plan gating:** Bot Management *score* (`cf.bot_management.score`),
account-level WAF, and Page Shield *policies* are Enterprise-only. On any
sub-Enterprise plan (Free / Pro / Business) a write that depends on them is
rejected — check the plan (core §3) before attempting.

**Bot targeting trap:** when a WAF rule should catch AI crawlers (Applebot,
ClaudeBot, PerplexityBot), match `cf.verified_bot_category eq "AI Search"`, NOT
`"Search Engine Crawler"`. See the core skill's `references/graphql-recipes.md`
§4 for the taxonomy and how to confirm a bot's category first.

## Section 5 — Write discipline (apply on every change)

Because there is no confirm-before-apply wrapper yet, do this by hand:

1. **Read current state first** (read via the **cloudflare** core skill) and show it to the user.
2. **State exactly what will change** — which record/rule/setting, from what to what.
3. **Confirm with the user before the write** — every write to a live account.
4. **Dry-run where the API allows it** (rulesets support validation-style calls).
5. **Re-read after the write** to confirm the applied state matches intent.
6. **Never hard-delete blindly** — prefer disabling a rule to deleting it when the
   goal is reversibility; deletion of a DNS record or ruleset is not
   soft-recoverable on Cloudflare's side.

## Section 6 — Constraints

- **Every operation is a write to a live account.** Confirm before applying;
  read-then-write, never write-blind.
- **Never expose the token** — supply it via env var to `curl`, never on the
  command line or in logs; never print `.env`.
- **Least-privilege token** — only the scopes for what you touch; rotate after use.
- **Respect plan gating** — Enterprise-locked features fail on Pro; check first.
- **Reads are not here** — route "show me / audit" intents to the `cloudflare`
  core skill. Worker deploys/routes are `cloudflare-deploy`.
