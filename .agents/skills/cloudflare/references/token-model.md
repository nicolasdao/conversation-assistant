# API Token — get it, scope it, use it

The whole Cloudflare constellation authenticates with **one scoped API token**
(Bearer auth) read from `CLOUDFLARE_API_TOKEN` (one shared `.env` across the
members — see the core SKILL.md §2.2). This file is the complete manual for
obtaining that token and granting it the exact permissions needed to use **100%**
of the constellation's API surface.

## 1. TL;DR

1. Create a **user-owned Custom API Token** at
   **https://dash.cloudflare.com/profile/api-tokens** (My Profile → API Tokens —
   NOT "Manage Account → API Tokens").
2. Grant the [combined permission set](#3-the-combined-token--100-of-the-surface)
   below, scoped to your specific account + zone.
3. Copy the token value **immediately** (Cloudflare shows it once) and put it in
   the shared `.env` as `CLOUDFLARE_API_TOKEN`.
4. Verify with `node scripts/cf.js rest GET "/user/tokens/verify"`.

> **It must be a USER-owned token, not an account-owned one.** The native Workers
> Builds API rejects account-owned tokens with `Invalid token` (account support is
> "coming soon"), and Super Bot Fight Mode (plus Page Rules, Registrar, Turnstile,
> Zero Trust) is also incompatible with account-owned tokens. A **Custom Token
> created under My Profile is user-owned by default** — so use that path.

## 2. Where to get it — dashboard walkthrough

1. **Open the API Tokens page.** Once logged in to
   **https://dash.cloudflare.com**, either:
   - paste the direct URL **https://dash.cloudflare.com/profile/api-tokens** (the
     reliable shortcut), or
   - navigate in the UI: click your **profile / account icon in the top-right
     corner** of the dashboard → **My Profile** → the **API Tokens** tab in the
     left-hand nav.

   ⚠️ Use the **My Profile → API Tokens** path (creates a **user-owned** token).
   Do NOT use **Manage Account → API Tokens** (that creates an **account-owned**
   token, which the constellation cannot use — see [§1](#1-tldr)). Cloudflare
   occasionally restyles this chrome; if the menu labels differ, the URL above is
   the durable anchor.
2. Click **Create Token**, then under **Custom token** click **Get started**.
   (Templates exist, but none covers this full surface — build a custom one.)
3. Give it a name (e.g. `constellation-full`).
4. **Add each permission row** in [§3](#3-the-combined-token--100-of-the-surface):
   pick the **scope** (Account / Zone / User) in the first dropdown, the
   **permission group** in the second, and the **access level** (Read / Edit) in
   the third. Click **+ Add more** for each row.
5. **Account Resources:** `Include` → your specific account (not "All accounts").
6. **Zone Resources:** `Include` → `Specific zone` → your zone (not "All zones").
7. **TTL:** optionally set a start/expiry (`expires_on`) — recommended for the
   write-capable token; rotate after use.
8. **Continue to summary** → **Create Token**.
9. **Copy the token value now — it is displayed exactly once.** Paste it into the
   shared `.env` as `CLOUDFLARE_API_TOKEN`. If you lose it, you must roll a new one.

Never use the legacy **Global API Key** (root-equivalent, unscoped, non-expiring).

## 3. The combined token — 100% of the surface

Grant these rows for one token that unlocks every API in the constellation.
**`Edit` is full CRUDL and implicitly includes `Read`** — so read-write rows need
only `Edit` (do not add a matching `Read` row). Verified rows are confirmed
against Cloudflare's primary docs; *Established* rows match this project's working
config and Cloudflare's standard taxonomy — **confirm every name against the live
list before shipping** (names are cosmetic and get renamed — see [§5](#5-verify-names-live--names-are-cosmetic)).

| Scope | Permission group | Access | Unlocks | Status |
|---|---|---|---|---|
| Account | **Account Analytics** | Read | GraphQL analytics — `httpRequestsAdaptiveGroups` (traffic) **and** `workersInvocationsAdaptive` (Workers usage). No `Edit` variant exists. | ✅ verified |
| Account | **Account Settings** | Read | Account discovery (needed by `wrangler`) | ✅ verified |
| Account | **Workers Scripts** | Edit | Deploy/upload Workers, runtime secrets; also covers the one Builds endpoint that retrieves the Worker's tag (`Read` is implied by `Edit`) | ✅ verified |
| Account | **Workers KV Storage** | Edit | Workers that bind KV (optional — only if used) | ✅ verified |
| Account | **Workers R2 Storage** | Edit | Workers that bind R2 (optional — only if used) | ✅ verified |
| Account | **Workers CI** *(a.k.a. "Workers Builds Configuration")* | Edit | **The native Workers Builds API** — repo connections, triggers, build env vars, manual builds, logs. The two names are the same group; match by `id`. | ✅ verified — **this is the row our old docs were missing** |
| Account | **Account WAF** *or* **Account Rulesets** | Edit | Account-level rate-limiting rulesets (`http_ratelimit`) | ✅ verified · ⭐ Enterprise-only |
| Zone | **Zone** | Edit | Zone / plan discovery (`GET /zones`, `Read` implied by `Edit`) **and** zone edits required to attach a custom domain to a Worker — without `Edit` here, custom-domain configuration fails | ✅ verified |
| Zone | **Workers Routes** | Edit | Worker routes + custom domains | ✅ verified |
| Zone | **DNS** | Edit | DNS records CRUD | ◻︎ established |
| Zone | **Zone WAF** | Edit | WAF custom rules (`http_request_firewall_custom`) | ◻︎ established |
| Zone | **Single Redirect** *(formerly "Dynamic Redirect")* | Edit | Redirect Rules — single/dynamic URL redirects (`http_request_dynamic_redirect` phase, e.g. www→apex). Works on all plans incl. Free. **`Zone Settings: Edit` does NOT cover this** — the rulesets engine needs its own scope. | ✅ verified (renamed) |
| Zone | **Zone Settings** | Edit | SSL/TLS mode, `min_tls_version`, HSTS, `always_use_https` | ◻︎ established |
| Zone | **SSL and Certificates** | Edit | Certificate/SSL management | ◻︎ established |
| Zone | **Bot Management** | Edit | Super Bot Fight Mode / Bot Management config | ◻︎ established · Bot Mgmt *score* is ⭐ Enterprise |
| Zone | **Client-side security** *(formerly "Page Shield")* | Edit | Page Shield status/config | ✅ verified (renamed) · *policies* ⭐ Enterprise |
| User | **User Details** | Read | User-token context (required for the Builds API) | ✅ verified |
| User | **Memberships** | Read | User-token context (required for the Builds API) | ✅ verified |

**Enterprise-gated (⭐):** account-level rate limiting, Bot Management *score*
(`cf.bot_management.score`), and Page Shield *policies* work only on an Enterprise
plan. On Free/Pro/Business a call that depends on them is rejected — that is a
plan limit, not a token problem.

**No permission needed:** **Deploy Hooks** are an unauthenticated `POST` to
`https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<ID>` — the ID
in the URL *is* the credential (treat the URL as a secret). And the one-time
**GitHub App install** for Workers Builds is a dashboard OAuth step, not a token
permission.

## 4. Least-privilege alternative — two tokens

The combined token is convenient but broad. For a tighter posture, split into two
and swap the `CLOUDFLARE_API_TOKEN` value per session:

- **Audit token (read-only)** — for the `cloudflare` core skill: `Account Analytics: Read`,
  `Zone: Read` (+ `Workers Scripts: Read`, `Zone Analytics: Read` if your queries need them).
- **Config token (read-write)** — for `cloudflare-deploy` / `cloudflare-config`:
  the `Edit` rows above matching the features you actually touch. Short expiry,
  rotate after use — treat it as the dangerous one.

Because all members read one `CLOUDFLARE_API_TOKEN` (one shared `.env` via
`sharedEnv`), you can only hold one value at a time — so the split means swapping
the value, not running both simultaneously. Most setups prefer the single combined
token; use the split only when least-privilege matters more than convenience.

## 5. Verify names live — names are cosmetic

Cloudflare **renames** permission groups (e.g. Page Shield → Client-side security;
Workers Builds appears as both "Workers CI" and "Workers Builds Configuration").
The dashboard dropdown and the API both key off a stable **`id`**, not the name.
Before shipping a token — especially for a script that creates tokens via the API
— pull the live catalog and match by `id`:

```bash
# needs a token allowed to read token metadata (a broad/admin token — the
# read-only audit token returns 9109 Unauthorized here).
node scripts/cf.js rest GET "/user/tokens/permission_groups"
# each result: { id, name, scopes, category } — use `id`, never hard-code names.
```

## 6. Verify the token works

```bash
node scripts/cf.js rest GET "/user/tokens/verify"   # -> status: active / disabled / expired
```

If a call returns `code 10000` / authentication error, the token is missing the
scope for that surface (or you're on the wrong token). If the **Workers Builds
API** returns `Invalid token`, the token is **account-owned** — recreate it under
**My Profile → API Tokens** (user-owned).

## 7. Billing endpoints reject scoped tokens

Every billing/subscription endpoint (`/zones/{id}/subscription`,
`/accounts/{id}/subscriptions`, `/user/billing/*`, …) returns `code 10000` for
**any** scoped token, regardless of permissions — they only honor the legacy
Global API Key. Do not add that key just to read a billing number; use the
dashboard (Account Home → Billing → Subscriptions).
