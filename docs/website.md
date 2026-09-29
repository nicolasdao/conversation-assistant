---
description: Tattle's website, hey-tattle.com — what the page contains, how it is hosted on Cloudflare as a static Worker, how pushes to master redeploy it, the domain and redirect, the security headers, and how to preview, deploy, and change it safely.
tags: [website, cloudflare, hosting, deployment, workers, dns, security, csp]
source:
  - website/index.html
  - website/assets/**
  - website/wrangler.jsonc
  - website/_headers
  - website/.assetsignore
  - website/experiments/**
---

# Website

Tattle's official website is **https://hey-tattle.com**. It is one page whose job is to explain the app and put a **Download for Mac** button at the very top. It lives in this repository under `website/`, next to the app, and is deployed to Cloudflare on every push to `master` that changes that folder.

## What is in `website/`

| Path | What it is |
| --- | --- |
| `index.html` | The page. Plain HTML: no framework, no bundler, no build step |
| `assets/` | Its styles (`theme.css`, the app's On Air tokens; `style.css`), scripts, and the Barlow fonts (SIL OFL, `assets/fonts/OFL.txt`) |
| `wrangler.jsonc` | The Cloudflare Worker's configuration |
| `_headers` | Security headers for every response (see [Security](#security)) |
| `.assetsignore` | Files in `website/` that are never uploaded: the config files, `experiments/`, Markdown, `.wrangler/` |
| `experiments/` | The ten design experiments the page grew out of (28 September 2026), with a gallery (`experiments/index.html`) and their shared brief (`experiments/_shared/BRIEF.md`). Kept for reference; **not deployed** |

The page was chosen from experiment `02-record-button`. Its sections, top to bottom:

0. **The header bar** (`assets/nav.js`), pinned to the top as the page scrolls: the app's own header strap (the ON AIR block, which the record key turns on, the name, the record clock), the show's rundown as tabs (`01 Rundown` … `05 Credits`; the section on screen lights up red like a segment going on air), a compact Download that slides in once the hero's is off screen, and a playhead along its bottom edge with a tick where each section starts. On a phone the tabs are a swipeable second row.
1. **The record key** (`assets/scene.js`, Three.js): the app icon as a glossy 3D key. Pressing it takes the page "on air" with rings, rising captions, and fact-check lower thirds. Without WebGL, `assets/main.js` draws a CSS key instead; with reduced motion, a calm version.
2. **Rundown**: what the app does, in five steps.
3. **Jev** (`#jev`): why a decision model makes live judgment affordable, with a replaying **Jev call** (`assets/sections.js`). The questions shown are Tattle's real ones; the answers are labelled as examples. It links to [TypeSafe AI](https://typesafe.ai) and [Jev's documentation](https://docs.typesafe.ai/). See [Jev](jev.md).
4. **Fast and slow** (`#systems`): System 1 and System 2, with a live stream of lines and the two systems' costs. See [System 1 and System 2](system1-system2.md).
5. **Before you go live**: the keys, the cost, privacy, signing.
6. **Credits** (`#credits`): who made Tattle, [Nicolas Dao](https://nicolasdao.com) at [Cloudless Labs](https://cloudlesslabs.com). The JSON-LD names them as `author` and `publisher`, and the head carries `<link rel="author">`.
7. **Fine print**: made by, license, consent, trademarks, and the latest release line.

Every figure on the page comes from the docs (`jev.md`, `system1-system2.md`, `mission.md`). Change the page's claims only from there: it must not say Tattle is free to run or needs no keys while that is untrue.

**The download button and the release line.** The page names the latest published release in its HTML: the two Download for Mac links go to that release's DMG, the line under the button gives its version and size, the footer's "Latest release" line its version, date, and release notes, and the JSON-LD its `softwareVersion` and `downloadUrl`. Each release writes these (see [Releases update the site](#releases-update-the-site)), so the page is right without JavaScript and for search engines. On top of that, `assets/download.js` asks GitHub's API for the latest release (`api.github.com/repos/nicolasdao/tattle/releases/latest`), points every `[data-download]` link at its `-arm64.dmg` asset, and fills the version, size, date, and release-notes link (the footer's "Latest release" line). The DMG's file name carries the version, so it cannot be a fixed URL. If the API cannot be reached (offline, rate limit of 60 requests an hour per visitor), the page keeps what its HTML says. On anything but a Mac (an iPad counts as not a Mac), the page shows "It's a Mac app" with a Copy link button instead of the download.

## Hosting

The site is the Cloudflare **Worker `tattle-website`**, in the project's Cloudflare account, serving `website/` as **static assets** (`"assets": { "directory": "." }`). There is no Worker script and no build: Cloudflare serves the files as they are. Hosting a site this size is free.

| Setting | Value |
| --- | --- |
| Domain | `hey-tattle.com`, a custom domain of the Worker (`routes` in `wrangler.jsonc`); Cloudflare manages its DNS record and certificate |
| `www.hey-tattle.com` | A **301** to `https://hey-tattle.com`, keeping the path and query: a zone redirect rule (`http_request_dynamic_redirect` phase), on a proxied placeholder record (`AAAA www 100::`) that exists only so the rule sees the traffic |
| HTTP | Always Use HTTPS is on, so `http://` answers 301 to `https://` |
| TLS | Minimum TLS 1.2 |
| `workers.dev` and preview URLs | Off (`workers_dev: false`, `preview_urls: false`): the site answers only on its domain |

**Visit counts** come from Cloudflare Web Analytics, which is on for the zone: Cloudflare adds its beacon script to the page as it serves it, and the counts are in the dashboard under **Analytics & Logs → Web Analytics**. It sets no cookies. The Content Security Policy must keep allowing its two addresses, or the beacon is blocked and nothing is counted (the browser console says so).

The zone is on Cloudflare's Free plan. Nothing in the repository holds the account ID, zone ID, or any token: Wrangler and the build find the account from the token.

## Deploying

**Automatically, on push.** Cloudflare's own CI (Workers Builds) watches the GitHub repository `nicolasdao/tattle` through the **Cloudflare GitHub App**:

| Trigger setting | Value |
| --- | --- |
| Branch | `master` only |
| Watch path | `website/*`: a push that changes nothing under `website/` does not deploy |
| Root directory | `/website` |
| Build command | none |
| Deploy command | `npx wrangler deploy` |
| Build variable | `SKIP_DEPENDENCY_INSTALL=1`, so the build does not `npm install` the whole app first |

A deploy takes about three minutes from the push. The builds, their logs, and the trigger are in the Cloudflare dashboard under **Workers & Pages → tattle-website → Deployments / Settings → Builds**. Branches other than `master` and pull requests (including those from forks) never build or deploy.

**By hand**, from `website/`, with a Cloudflare API token in the environment (see [The Cloudflare skills](#the-cloudflare-skills-and-the-token)):

```bash
cd website
set -a; . ../secrets/cloudflare.env; set +a   # loads CLOUDFLARE_API_TOKEN without printing it
npx wrangler deploy --dry-run                 # what would be uploaded (18 files at the first deploy)
npx wrangler deploy
```

Set `CLOUDFLARE_ACCOUNT_ID` too if the token can see more than one account.

**Previewing.** `npx wrangler dev` in `website/` serves the page on http://localhost:8787 exactly as Cloudflare does, headers included. Any static server also works for layout (`python3 -m http.server` in `website/`), but it does not apply `_headers`.

## Security

`_headers` gives every response:

| Header | Why |
| --- | --- |
| `Content-Security-Policy` | Scripts only from the site itself, `cdn.jsdelivr.net` (Three.js), and `static.cloudflareinsights.com` (Web Analytics), plus the page's inline import map by its SHA-256 hash; styles from the site (inline `style` attributes allowed); images from the site and `data:`; network calls only to the site, `api.github.com`, and `cloudflareinsights.com` (the visit Web Analytics reports); no plugins, forms, `<base>`, or framing |
| `Strict-Transport-Security` | Browsers use HTTPS for a year |
| `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` | No MIME sniffing, no framing, a minimal referrer, no camera/microphone/location/payment access, an isolated browsing context |

**Three.js is pinned by integrity.** The page's import map loads Three.js 0.170.0 from jsDelivr and lists a `sha384` for each file it loads (`three.module.js`, `RoomEnvironment.js`, `BufferGeometryUtils.js`). A modified file on the CDN is refused, and the page falls back to the CSS key.

**Changing either means recomputing a hash**, or the 3D key silently falls back (see [Gotchas](gotchas.md#website-and-cloudflare)):

```bash
# After editing the <script type="importmap"> block: its hash, for script-src in _headers
python3 -c "import re,hashlib,base64;s=open('website/index.html').read();m=re.search(r'<script type=\"importmap\">(.*?)</script>',s,re.S);print('sha256-'+base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode())"
# After changing a Three.js version or file: its integrity, for the import map
curl -sL https://cdn.jsdelivr.net/npm/three@<version>/build/three.module.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Check with `npx wrangler dev` and the browser console: a blocked script is reported there.

**Who can deploy.** A push to `master` of `nicolasdao/tattle` deploys, so the site is exactly as safe as write access to that repository and the Cloudflare account. Forks cannot push to it, the repository has no GitHub Actions and holds no deploy secret, and fork pull requests never run a Cloudflare build. Keep two-factor authentication on the GitHub and Cloudflare accounts.

## The Cloudflare skills and the token

Three Claude Code skills, installed in this project, manage the account: `cloudflare` (read-only audits: traffic, Workers usage, token scopes), `cloudflare-config` (DNS, redirect and WAF rules, zone settings), and `cloudflare-deploy` (Workers deploys and Workers Builds). They share one API token:

- It lives in **`secrets/cloudflare.env`** as `CLOUDFLARE_API_TOKEN` (the path is set in `skills-config.json`). The whole `secrets/` folder is git-ignored; `.env.example` lists the variable with no value.
- It must be a **user-owned** custom token (created under **My Profile → API Tokens**, not Manage Account), because the Workers Builds API rejects account-owned tokens. The permissions this site needs: Account Analytics and Account Settings (Read); Workers Scripts and Workers CI (Edit); Zone, Workers Routes, DNS, Zone Settings, SSL and Certificates, and Single Redirect (Edit), scoped to `hey-tattle.com`; User Details and Memberships (Read). The full list is in `.agents/skills/cloudflare/references/token-model.md`.
- Give it an expiry date and roll it after heavy use. Never paste it into a chat, a commit, or a command line.

The `cloudflare` skill's `cf.js` needs a workaround in this repository (see [Gotchas](gotchas.md#website-and-cloudflare)).

## Changing the site

1. Edit files under `website/`; preview with `npx wrangler dev`.
2. If the import map or a Three.js version changed, recompute the hashes ([Security](#security)).
3. Commit and push to `master`. Cloudflare redeploys within minutes; check **Deployments** in the dashboard, or https://hey-tattle.com.

### Releases update the site

The release skill (`release-tattle`, Step 11) finishes every deployed release by pointing the page at it, after production is verified:

1. `update-website.sh <version>` reads the **published** GitHub Release (it refuses one that is not published) and writes its version, DMG link, size, date, and release-notes link into `website/index.html`. It checks that each element it edits is still on the page, and fails if the page changed shape: update the script with the page, never by hand around it.
2. `deploy-website.sh <version>` commits `website/index.html` alone (`chore(website): point the download and release line at v<version>`), pushes `master`, and waits until https://hey-tattle.com links the new DMG.

Both are in `.agents/skills/release-tattle/scripts/` and run from the project root. Between a release and that commit, visitors with JavaScript already see the new release, because `download.js` reads it from GitHub.

Related: [The Mac app](desktop.md) (the DMG the page downloads), [Jev](jev.md), [System 1 and System 2](system1-system2.md), [Mission](mission.md).
