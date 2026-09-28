# GraphQL Analytics API — recipes and traps

The Cloudflare GraphQL Analytics API (`POST https://api.cloudflare.com/client/v4/graphql`)
is the only practical way to pull historical traffic and Workers metrics —
`wrangler` doesn't expose them. The schema is well-typed but has non-obvious
naming traps that waste a build cycle on the first run.

## 1. The top-level metric is `count`, not `requests`

The intuitive query is wrong:

```graphql
httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $since }) {
  sum { requests }    # ❌ rejected: "unknown field requests"
}
```

`requests` doesn't exist on `ZoneHttpRequestsAdaptiveGroupsSum`. The request
count is the **top-level `count` field** on the group itself; `sum` holds other
metrics (bytes, visits, latency quantiles):

```graphql
httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $since }) {
  count
  sum { edgeResponseBytes visits }
}
```

**Rule:** On every `*AdaptiveGroups` type, `count` is the row count (≈ request
count) and lives at the top level. Other metrics live inside `sum`, `avg`, or
`quantiles` with provider-specific names — never assume by analogy with another
API.

Caveat for Workers: `workersInvocationsAdaptive` is different — there the count
IS `sum { requests }` (not top-level `count`), and CPU is
`quantiles { cpuTimeP50 cpuTimeP99 }`. Confirm per node; do not generalize.

## 2. `orderBy` enums are positional names, not field paths

```graphql
orderBy: [dimensions_date_ASC]   # ❌ "unknown enum value"
orderBy: [sum_requests_DESC]     # ❌ "requests" doesn't exist
```

The actual enum names are **flat positional tokens** matching the introspected
field path:

```graphql
orderBy: [count_DESC]                    # sort by row count, desc
orderBy: [sum_edgeResponseBytes_DESC]    # sort by bytes-sum, desc
```

There is no `dimensions_<name>_*` enum — you can't `orderBy` a dimension. To get
rows in date order, drop `orderBy` and sort client-side after fetching (one row
per date bucket, so the sort is O(N) on a small N).

## 3. Always introspect the schema before a non-trivial query

Fields on `httpRequestsAdaptiveGroups` change between Cloudflare plans. Bot
Management dimensions (`botScore`, `botManagementDecision`), fraud fields, WAF
attack scores, content-scanner fields are all plan-gated. Hand-writing queries
from blog posts or guesses produces silent shape mismatches that surface as
"unknown field" at runtime.

Two introspection queries are usually enough:

```graphql
# Available aggregations on the group
{ __type(name: "ZoneHttpRequestsAdaptiveGroupsSum") { fields { name } } }

# Available dimensions to group by or filter on
{ __type(name: "ZoneHttpRequestsAdaptiveGroupsDimensions") { fields { name } } }
```

**Rule:** Before any non-trivial Analytics query, run the two introspection
queries and confirm every field you intend to use exists on the current plan.
Two minutes of introspection saves an hour of guessing.

## 4. `verifiedBotCategory` taxonomy — Applebot is `"AI Search"`

When filtering traffic by `verifiedBotCategory`, the natural assumption is that
Applebot sits under `"Search Engine Crawler"` alongside Googlebot and Bingbot.
**It doesn't.** Cloudflare classifies Applebot — and `Amzn-SearchBot`,
ClaudeBot, PerplexityBot — under `"AI Search"`, reflecting that these crawlers
now feed AI assistants rather than only powering web search.

Representative category counts from a bot-heavy zone during a crawler spike —
note how the AI-Search bucket dwarfs the traditional search-engine one:

```
verifiedBotCategory                count
"AI Search"                      662,324
""                                 8,425   (humans + uncategorized clients)
"Search Engine Crawler"              300   (Bingbot, Googlebot)
"Search Engine Optimization"           4
```

A WAF rule keyed on `(cf.verified_bot_category eq "Search Engine Crawler")`
would **not** match Applebot. To target the AI-Search crawlers at the edge (swap
in your own path prefix):

```
(cf.verified_bot_category eq "AI Search") and (http.request.uri.path matches "^/your-path/.+")
```

**Rule:** When writing WAF expressions or filtering analytics on
`verifiedBotCategory`, run a count-by-category query first and check the actual
category Cloudflare assigns to the specific bot. "Search engine" no longer
includes AI-search crawlers as of Cloudflare's 2025 taxonomy update.

## 5. Bot-category breakdown query

Count requests grouped by verified-bot category for a zone:

```bash
node scripts/cf.js graphql \
  'query($zone:string!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:100,filter:{datetime_geq:$start,datetime_leq:$end}){count dimensions{verifiedBotCategory}}}}}' \
  '{"zone":"<ZONE_ID>","start":"2026-05-27T00:00:00Z","end":"2026-06-03T23:59:59Z"}'
```

Sort client-side by `count` (you can't `orderBy` a dimension — see §2).
