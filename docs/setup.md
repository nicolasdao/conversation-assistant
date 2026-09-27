---
description: The two API keys (OpenAI and OpenRouter) — the first-run setup screen that replaces the app until both are set, where keys are stored on the Mac, how each key is checked before it is saved, the setup routes and their gate, and how the command-line tools find the keys.
tags: [setup, api-keys, onboarding, credentials, security, openai, openrouter]
source:
  - src/keys.ts
  - web/src/keys.ts
  - web/src/main.ts
  - src/cli/smoke.ts
  - src/cli/replay.ts
---

# Setup and API keys

Conversation Assistant needs two keys, and nothing works without them:

| Key | Service | Used for | About |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI | Transcription, final and live (see [Transcription](transcription.md)) | $1.23 an hour |
| `OPENROUTER_API_KEY` | OpenRouter | Jev, System 2 (GPT-6 Luna), and chat (see [Jev](jev.md), [Chat](chat.md)) | up to $0.40 an hour, plus chat |

## First run: the setup screen

Until both keys are set, the page shows only the setup screen; the app's code is not even loaded. `web/src/main.ts` asks `GET /api/setup` first: when `configured` is false it shows the screen (`web/src/keys.ts`), otherwise it imports the app (`web/src/app.ts`). The page's shell is hidden (`body.booting`) until that answer arrives, so it never flashes first.

The screen is built around one call to action: fill two fields, press one button. It fits a laptop screen without scrolling:

- a title ("Add your two API keys to start") and one line on why;
- one panel with a large field per missing key, labelled "OpenAI API key" / "OpenRouter API key", each with a **Required** badge. As a key is typed, `formatProblem` checks it in the page: the field turns green with "✓ Looks right", or red with "Check this key" and the reason (an OpenRouter key in the OpenAI field, spaces, too short). The field hides the key (Show reveals it), and Enter saves;
- under each field, one line on what it does, and **How do I get an … key?**, folded: what the service does and costs, then the steps with direct links (create an account, **add prepaid credit** — $10 is plenty, automatic recharge off — create a key named Conversation Assistant, on OpenRouter with a credit limit such as $10, and paste it);
- one full-width **Save keys and start** button, dimmed until both fields look right, with a counter ("1 of 2 keys added");
- inside the panel, under the button, a padlock and **Your keys stay on this Mac**: the app has no server of its own; keys are saved on this computer and sent only to OpenAI and OpenRouter, to use the account with them — never to the project's authors or anywhere else. It sits where the eye lands before pressing Save, because that is when people worry about handing over a key;
- one small footer line: what a show costs, and the file the keys are saved in.

The button checks each key with its service and saves them only if none is refused; each result shows under its field. If a check leaves a warning, the screen shows an **Open Conversation Assistant** button; otherwise the app opens by itself after about a second.

Keys can be replaced later from the cog menu → **API keys** (`?panel=keys`). There, the steps are folded under "How to get this key", each card shows the key in use by its last 4 characters, and a key set in `.env` is shown but cannot be edited.

## Where keys are stored

In order, first match wins:

1. **The environment**: a shell variable, or `.env` in the project folder (the npm scripts load it with `--env-file-if-exists`, so it is optional). A key set here cannot be changed from the page.
2. **`~/Library/Application Support/Conversation Assistant/credentials.json`**, written by the page. This is the macOS location for per-user app data. It sits outside the project folder, so a key can never be committed, and it survives a re-clone or an upgrade.

`src/keys.ts` (`KeyStore`) writes the file:

- the folder is `0700` and the file `0600`, so only this macOS user can read them;
- a file found with wider permissions (restored from a backup, say) is tightened when it is read;
- it writes to a temporary file and then renames it, so a crash never leaves half a file;
- the file is JSON, named by environment variable: `{ "OPENAI_API_KEY": "…", "OPENROUTER_API_KEY": "…" }`;
- an unreadable file is ignored with a console warning, so the page asks for the keys again.

At startup, `load()` copies the file's keys into `process.env` wherever the environment has none. Everything else keeps reading `process.env`. A key saved from the page is also written into `process.env` at once, and the parts that hold a key read it on each use, so no restart is needed:

- the chat's key is a getter;
- `processSecrets()` redacts the keys current at each write.

Sessions pick keys up when they start. `CONVERSATION_ASSISTANT_CREDENTIALS` overrides the file's path (tests use it).

Keys never appear in logs, session files, events, or exports. The API returns only a key's last 4 characters (`hint`).

## Checking a key before saving

`checkKey` first catches common paste mistakes, then asks the service, free of charge:

| Check | Refused (nothing saved) | Saved, with a warning |
| --- | --- | --- |
| Format | Empty, whitespace inside, under 20 or over 400 characters, an OpenRouter key (`sk-or-`) in the OpenAI field, an OpenAI-style key in the OpenRouter field | — |
| OpenAI `GET /v1/models` | 401 | The key cannot use the transcription models in `config/app.json` (`transcription.model`, and `transcription.live.model` when enabled); any other HTTP error |
| OpenRouter `GET /api/v1/key` | 401 | `is_free_tier` (no credit ever added); no credit limit on the key; any other HTTP error |
| Network | — | Service unreachable (offline) |

A successful OpenRouter check reports the key's limit and remaining credit.

An OpenAI account with no credit cannot be detected for free. It answers `429 insufficient_quota` on the first real call (see [Gotchas](gotchas.md)), which is why the screen insists on adding credit first.

## Routes and the gate

When `createApiServer` is given `setup` (`npm run serve` always gives it):

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/setup` | `{ configured, keys: [{ name, env, set, source: "environment" \| "file" \| null, hint }], path }`; `path` uses `~` |
| POST | `/api/setup/keys` | `{ openai?, openrouter? }`. Checks each key given, saves them all or none. Returns `{ saved, checks: { <name>: { ok, message, warning? } }, …status }`. 409 for a key set in the environment |

- **Gate.** Until both keys are set, every other `/api/*` route answers `503 { error, setup: true }`, except `/api/about` and `/api/engine`.
- **Only the page itself.** The setup routes answer only when the `Host` is `127.0.0.1` or `localhost` (no DNS rebinding) and any `Origin` matches it (no other website open in the browser). The POST also requires `Content-Type: application/json`, which a cross-site form cannot send.
- The server prints which keys are missing when it starts. `serve --replay` refuses to start a replay until both are set.

## Command-line tools

`smoke` and `replay` call `loadKeys()` before reading a key. `preflight`'s "keys are set" check says where each key came from, and names the missing ones with how to add them. All of them load `.env` only if it exists.

Related: [Architecture](architecture.md), [Mission](mission.md).
