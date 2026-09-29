---
description: The two API keys (OpenAI and OpenRouter), both optional — which one the transcription engine requires, the first-run setup screen (OpenAI only, on Macs that transcribe with OpenAI), the prompts that ask for the OpenRouter key when fact-checking, labels, or Chat need it, where keys are stored on the Mac, how each key is checked before it is saved, the setup routes and their gate, and how the command-line tools find the keys.
tags: [setup, api-keys, onboarding, credentials, security, openai, openrouter, first-run, key-prompt]
source:
  - src/keys.ts
  - web/src/keys.ts
  - web/src/main.ts
  - src/cli/smoke.ts
  - src/cli/replay.ts
  - src/cli/preflight.ts
---

# Setup and API keys

Tattle has two API keys, and neither is needed to open the app on macOS 26 or later:

| Key | Service | Needed for | About |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI | Transcription with the OpenAI engine only (see [Transcription](transcription.md)) | $1.23 an hour |
| `OPENROUTER_API_KEY` | OpenRouter | Fact-checking and labels (Jev, System 2), and Chat (see [Jev](jev.md), [Chat](chat.md)) | up to $0.40 an hour, plus chat |

Which keys are **required** follows the transcription engine (`KeySetup.status().required`): `["openai"]` when OpenAI transcribes, `[]` with Apple Speech on this Mac. OpenRouter is never required: without it a session is transcript-only, and on macOS 26+ with Apple Speech it runs fully offline. Before 29 September 2026 both keys were required on every Mac.

## First run: the setup screen

Until the required keys are set, the page shows only the setup screen; the app's code is not even loaded. `web/src/main.ts` asks `GET /api/setup` first: when `configured` is false it shows the screen (`web/src/keys.ts`), otherwise it imports the app (`web/src/app.ts`). The page's shell is hidden (`body.booting`) until that answer arrives, so it never flashes first.

So on macOS 26+ a first launch asks for nothing: the engine resolves to Apple Speech and the app opens (see [Transcription](transcription.md#choosing-the-engine--srcsettingsts)). The screen appears only when OpenAI transcribes without its key: a Mac on macOS 14.2–25, or someone who chose OpenAI. It shows only the required missing keys, so in practice one field. It fits a laptop screen without scrolling:

- a title ("Add your OpenAI API key to start") and one line on why: "On-device transcription needs macOS 26 or later. On this Mac, Tattle transcribes with OpenAI…" (from `GET /api/transcription`, which answers before any key is set), or "You chose OpenAI for transcription.";
- one panel with a large field per missing key, with a **Required** badge. As a key is typed, `formatProblem` checks it in the page: the field turns green with "✓ Looks right", or red with "Check this key" and the reason (an OpenRouter key in the OpenAI field, spaces, too short). The field hides the key (Show reveals it), and Enter saves;
- under the field, one line on what it does, and **How do I get an … key?**, folded: what the service does and costs, then the steps with direct links (create an account, **add prepaid credit** — $10 is plenty, automatic recharge off — create a key named Tattle, and paste it);
- one full-width **Save key and start** button, dimmed until the field looks right;
- inside the panel, under the button, a padlock and **Your keys stay on this Mac**: the app has no server of its own; each key is saved on this computer and sent only to its own service — never to the project's authors or anywhere else. It sits where the eye lands before pressing Save, because that is when people worry about handing over a key;
- one small footer line: what a transcript costs, that fact-checking and labels need an OpenRouter key the app asks for when they are turned on, and the file the keys are saved in.

The button checks each key with its service and saves them only if none is refused; each result shows under its field. If a check leaves a warning, the screen shows an **Open Tattle** button; otherwise the app opens by itself after about a second.

## Asking for a key where it is needed

`keyPrompt(name, heading, …)` in `web/src/keys.ts` shows a key's card (its guide open, the field, **Save**, and optionally **Not now**) inside the window that needs it. It is always inside the open `<dialog>`: everything outside a modal dialog is inert (see [Gotchas](gotchas.md#web-page)).

- **Start live.** The switches start **on** when the OpenRouter key is set and **off** when it is not. Turning one on without the key shows, inside `#dlg-start`, "Please provide your OpenRouter API key to configure fact-checking or labeling." **Not now** turns every switch that needs the key back off; a saved key keeps the switch on. Pressing Start with a switch on and no key shows the prompt instead of starting.
- **Chat.** Opening it without the key shows "Please provide your OpenRouter API key to use Chat." in place of the chat; saving opens the chat.
- **Settings → Transcription.** Choosing OpenAI without its key shows the OpenAI card first, then saves the engine.
- **Replays** started from the replay popover or the Recordings window run with fact-checking and labels only when the OpenRouter key is set.

The server refuses the same cases, so a stale page cannot slip past: `POST /api/session/start` (live or replay) with a feature on and no OpenRouter key, and the chat's POST routes without it, answer 400 `{ error, needsKey: "openrouter" }`; starting with the OpenAI engine and no OpenAI key answers 400 `needsKey: "openai"`. The page reads `needsKey` from the error (`ApiError.body` in `web/src/api.ts`) and shows the prompt.

Keys can be replaced later from **Tattle → Settings…** (⌘,) in the Mac app, or the cog menu → **API keys** in a browser; both open the same window (`?panel=keys`). There, each card says when its key is needed ("Needed only for OpenAI transcription." / "Needed for fact-checking, labels, and Chat."), the steps are folded under "How to get this key", each card shows the key in use by its last 4 characters, and a key set in `.env` is shown but cannot be edited.

## Where keys are stored

In order, first match wins:

1. **The environment**: a shell variable, or `.env` in the project folder (the npm scripts load it with `--env-file-if-exists`, so it is optional). A key set here cannot be changed from the page. This is for development: the Mac app, opened from Finder, has no project folder and no shell environment, so it uses the file below.
2. **`~/Library/Application Support/Tattle/credentials.json`**, written by the page. This is the macOS location for per-user app data. It sits outside the project folder, so a key can never be committed, and it survives a re-clone or an upgrade. `npm run serve` and the Mac app share it (`appSupportDir()` in `src/paths.ts`), and the Mac app keeps its recordings next to it (see [The Mac app](desktop.md)). Both move the folder from before the rename, `~/Library/Application Support/Conversation Assistant/`, into place at launch (see [The Mac app](desktop.md#the-name-and-what-kept-the-old-one)).

`src/keys.ts` (`KeyStore`) writes the file:

- the folder is `0700` and the file `0600`, so only this macOS user can read them;
- a file found with wider permissions (restored from a backup, say) is tightened when it is read;
- it writes to a temporary file and then renames it, so a crash never leaves half a file;
- the file is JSON, named by environment variable: `{ "OPENAI_API_KEY": "…", "OPENROUTER_API_KEY": "…" }`;
- an unreadable file is ignored with a console warning, so the page asks for the keys again.

At startup, `load()` copies the file's keys into `process.env` wherever the environment has none. Everything else keeps reading `process.env`. A key saved from the page is also written into `process.env` at once, and the parts that hold a key read it on each use, so no restart is needed:

- the chat's key is a getter;
- `processSecrets()` redacts the keys current at each write.

Sessions pick keys up when they start. `TATTLE_CREDENTIALS` overrides the file's path (tests use it).

Keys never appear in logs, session files (the chat log included), events, or exports. The API returns only a key's last 4 characters (`hint`). Child processes, the capture helper and `afconvert`, get the environment without them (`childEnv` in `src/keys.ts`): none needs a key.

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

When `createApiServer` is given `setup` (`bootEngine()` always gives it, for `npm run serve` and the Mac app):

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/setup` | `{ configured, required, keys: [{ name, env, set, source: "environment" \| "file" \| null, hint }], path }`; `required` lists the keys the engine needs; `path` uses `~` |
| POST | `/api/setup/keys` | `{ openai?, openrouter? }`. Checks each key given, saves them all or none. Returns `{ saved, checks: { <name>: { ok, message, warning? } }, …status }`. 409 for a key set in the environment |

- **Gate.** Until the required keys are set, every other `/api/*` route answers `503 { error, setup: true }`, except `/api/transcription`, `/api/about`, `/api/licenses`, and `/api/engine`. With Apple Speech nothing is required, so nothing is gated.
- **Only the page itself.** Like every route (see [Architecture](architecture.md#event-bus-and-api--srcstoreeventsts-srcservermaints)), the setup routes answer only when the `Host` is `127.0.0.1` or `localhost` (no DNS rebinding) and any `Origin` matches it (no other website open in the browser). The POST also requires `Content-Type: application/json`, which a cross-site form cannot send. In the Mac app, only the app's own window can reach the router at all, so the in-process connection presents its requests as the page itself: `Host: 127.0.0.1` and no `Origin` (see [The Mac app](desktop.md#the-in-process-connection--srcserverinprocessts)).
- `npm run serve` prints the engine and any missing required key when it starts. `serve --replay` runs fact-checking and labels, so it also needs the OpenRouter key.

## Command-line tools

`smoke` and `replay` call `loadKeys()` before reading a key. `replay` needs no key with `--engine apple --no-factcheck --no-labels`. `preflight`'s "keys are set" check says where each key came from; it fails only when the engine needs the OpenAI key, and notes a missing OpenRouter key without failing (its credit, Jev, and System 2 checks are then skipped). All of them load `.env` only if it exists.

Related: [Architecture](architecture.md), [Mission](mission.md).
