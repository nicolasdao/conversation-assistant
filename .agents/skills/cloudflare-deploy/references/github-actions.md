# Route A — GitHub Actions (and GitLab CI) with `wrangler deploy`

The canonical **dashboard-free** way to deploy a Worker on push to your default
branch. Your
CI runs `wrangler deploy`; Cloudflare's native Git integration is not involved,
so there is nothing to install in the dashboard. This is the recommended default.

## 1. Minimal GitHub Actions workflow

`.github/workflows/deploy.yml`:

```yaml
name: Deploy Worker
on:
  push:
    branches: [main]   # your default branch — main, master, etc.
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- `cloudflare/wrangler-action@v3` runs **`wrangler deploy` by default**. Override
  with the `command:` input (e.g. `command: deploy --env production`) or add a
  build step before it.
- The `@v3` v-prefix is required (current major).
- If your build needs dependencies, add a `run: npm ci` step (and a
  `preCommands:`/`postCommands:` on the action if you prefer it inline).

## 2. Secrets and token scopes

Set two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A scoped token with **Workers Scripts: Edit** (+ **Workers Routes: Edit** if the deploy sets routes) |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID (from `cf.js rest GET "/zones?name=<zone>"` → `result[0].account.id`) |

- Account ID is not strictly a secret, but wrangler needs it: without it (and
  without `account_id` in `wrangler.toml`) the action fails with
  "No account id found, quitting". Supplying it as a secret or in wrangler config
  both work.
- Use the least-privilege **config** token scopes from the core skill's
  `references/token-model.md`. Do not reuse the read-only audit token — it can't
  deploy.

## 3. GitLab CI equivalent

Same `wrangler deploy` pattern. In `.gitlab-ci.yml`, the deploy job's `script`
runs wrangler; set the two CI/CD variables in Settings → CI/CD → Variables:

```yaml
deploy:
  image: node:lts
  script:
    - npx wrangler deploy
  rules:
    - if: $CI_COMMIT_BRANCH == "main"   # your default branch
```

| CI/CD variable | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | scoped config token |
| `CLOUDFLARE_ACCOUNT_ID` | account ID |

Any CI that can run `npx wrangler deploy` with those two env vars works the same
way (CircleCI, Jenkins, Buildkite, …).

## 4. Why this over Cloudflare's native Builds

- **Zero dashboard steps** — no Cloudflare GitHub App install, no Git-integration
  object. The trigger config is version-controlled YAML in your repo.
- **Portable** — the same pattern deploys from any CI, not just GitHub.
- Trade-off: build logs live in your CI, not in the Cloudflare dashboard, and you
  own the runner. If you specifically want Cloudflare's build UI and logs, use
  Route B (native Workers Builds) — see `workers-builds-api.md`.
