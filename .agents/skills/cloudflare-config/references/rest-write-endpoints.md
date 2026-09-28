# Cloudflare REST write endpoints

Reference for the write operations this skill performs. Base:
`https://api.cloudflare.com/client/v4`. All calls use `Authorization: Bearer
$CLOUDFLARE_API_TOKEN` (supplied via env var, never on the command line) and
return the envelope `{success, errors, messages, result, result_info}`. Global
rate limit: 1,200 requests / 5 min.

Apply the write discipline in SKILL.md §5 to every call: read → state the change
→ confirm → apply → re-read.

## 1. DNS records

Discover IDs with a read first — use the **cloudflare** core skill to
`GET /zones/{zone_id}/dns_records` (it bundles the read-only `cf.js` wrapper).

| Operation | Method + path |
|---|---|
| Create | `POST /zones/{zone_id}/dns_records` |
| Full update | `PUT /zones/{zone_id}/dns_records/{record_id}` |
| Partial update | `PATCH /zones/{zone_id}/dns_records/{record_id}` |
| Delete | `DELETE /zones/{zone_id}/dns_records/{record_id}` |

Body shape (create/update):

```json
{ "type": "A", "name": "sub.example.com", "content": "203.0.113.10", "ttl": 1, "proxied": true }
```

- `proxied: true` routes the record through Cloudflare's edge (orange cloud —
  gets CDN/WAF/caching). `proxied: false` is DNS-only (grey cloud). Getting this
  wrong silently changes whether the edge sees the traffic.
- `ttl: 1` means "automatic" when proxied.
- `DELETE` is not soft-recoverable on Cloudflare's side — re-create from the
  values you read before deleting.

## 2. WAF custom rules (rulesets engine)

WAF custom rules live in the **rulesets** engine at the `http_request_firewall_custom`
phase.

| Operation | Method + path |
|---|---|
| List zone rulesets | `GET /zones/{zone_id}/rulesets` |
| Get entrypoint for a phase | `GET /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint` |
| Update the phase ruleset (add/replace rules) | `PUT /zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint` |

Each rule has an `expression` (Cloudflare's firewall language) and an `action`
(`block`, `managed_challenge`, `js_challenge`, `skip`, `log`). Example rule to
challenge AI-search crawlers on a path:

```json
{
  "action": "managed_challenge",
  "expression": "(cf.verified_bot_category eq \"AI Search\") and (http.request.uri.path matches \"^/your-path/.+\")",
  "description": "Challenge AI crawlers on a chosen path prefix"
}
```

Prefer `action: "log"` first to observe what a rule *would* match before you
`block`. Disabling a rule (`enabled: false`) is more reversible than deleting it.

## 3. Rate limiting

Rate-limit rules are also rulesets, at the `http_ratelimit` phase:

`PUT /zones/{zone_id}/rulesets/phases/http_ratelimit/entrypoint`

Each rule carries a `ratelimit` block (`characteristics`, `period`,
`requests_per_period`, `mitigation_timeout`).

## 4. Zone settings (SSL/TLS, HSTS, etc.)

| Operation | Method + path |
|---|---|
| Read all settings | `GET /zones/{zone_id}/settings` |
| Change one setting | `PATCH /zones/{zone_id}/settings/{setting_id}` |

Common `setting_id`s: `ssl` (`off`/`flexible`/`full`/`strict`),
`min_tls_version`, `security_header` (HSTS), `always_use_https`,
`automatic_https_rewrites`. Body: `{ "value": "strict" }`.

## 5. Super Bot Fight Mode / Bot Management / Page Shield

- **Super Bot Fight Mode** (Pro plan and above) — configured via the
  bot-management settings on the zone: `PUT /zones/{zone_id}/bot_management`.
- **Bot Management *score*** (`cf.bot_management.score`) — **Enterprise-only**;
  rejected on sub-Enterprise plans.
- **Page Shield** — `PUT /zones/{zone_id}/page_shield` to enable; **policies**
  are Enterprise-only.

Check the plan (core §3) before attempting any of these — a sub-Enterprise plan
rejects the Enterprise-only variants with a permissions error, not a helpful
message.

## 6. Verifying a token can do the write

Before a write session, confirm the token carries the needed Edit scope. This
skill bundles only `curl` (the read-only `cf.js` wrapper lives in the
**cloudflare** core skill), so verify with the same no-leak `curl --config`
pattern used for every write:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | \
curl -sS --config - "https://api.cloudflare.com/client/v4/user/tokens/verify"
```

If a write returns `code 10000` / authentication error, the token is missing the
scope (or you're on the wrong token — the read-only audit token cannot write).
