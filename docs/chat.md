---
description: The chat window — questions about the transcript of the session on screen, live or recorded, to any curated OpenRouter model — how a live chat keeps up with the transcript, storage, cost and its cap, the API, and the page.
tags: [chat, openrouter, llm, transcript, cost, api, web]
source:
  - src/chat/**
  - web/src/chat.ts
  - web/src/markdown.ts
---

# Chat

The **Chat** window lets the host ask any of a curated list of models about the transcript of the session on screen: the show on air, or a recording opened from the library. It works like ChatGPT or Claude, but the transcript is its only attachment (no files or images). It opens from the header's Chat button or ⌘K / Ctrl+K, as a large window over the page.

The chat is a tool for the host, separate from the demonstration. It is not part of System 1 or System 2, and never makes the judgments Jev makes (see [Mission](mission.md)).

## How a chat keeps up with a live transcript

A chat only ever **appends** to what it has sent:

```text
system:     how to read the transcript (fixed text)
user:       <transcript status="live, still being recorded" lines="120" up_to="10:12"> …all lines… </transcript>
            <question>…</question>
assistant:  answer 1
user:       <transcript_update lines="121–164" up_to="22:40"> …lines said since question 1… </transcript_update>
            <question>…</question>
```

- **Each question carries the lines that arrived since that chat's previous question.** It uses a cursor: the question's `lines.to`, the number of final lines (fillers left out, in arrival order) sent so far. So a question asked on air sees everything said up to that moment.
- **Nothing sent is ever rewritten.** Each request starts with the byte-identical conversation of the one before it, which the provider's prompt cache can serve cheaply.
  - OpenAI and most others cache a repeated prefix on their own.
  - For `anthropic/*` models the latest question is marked `cache_control: ephemeral`.
- **Speaker renames and merges** made after lines were sent are announced in the next question (`<speaker_names>"Speaker 2" in earlier lines is now called "Alice".</speaker_names>`), instead of rewriting earlier text. **The recording ending** is announced the same way.
- A question with nothing new says `No new lines since the previous question.`
- Lines read `[m:ss] Speaker: text`, and the system prompt asks the model to cite moments as `[12:34]`. The page turns every cited time into a button (see [The page](#the-page--websrcchatts-websrcmarkdownts)).
- Only final transcripts are sent (`utterance` events), never the streaming live text. A line still being transcribed goes with the next question.
- A finished recording works the same way; there is simply nothing left to add.

Sizes: a two-hour episode (1,656 lines) is about 30k tokens, far inside every listed model's context window. The meter turns amber past 80% of the window and suggests a new chat.

Nothing is created, sent, or spent until the first question of a new chat. Opening the window and **+ New chat** cost nothing.

## Models — `config/app.json` `chat`

| Key | Value | Meaning |
| --- | --- | --- |
| `defaultModel` | `openai/gpt-6-luna` | A new chat's model |
| `models` | 14 ids | The curated list the picker shows: GPT-6 Luna, Sol, Astra; Claude Sonnet 5, Opus 5.5, Fable 5.1; Gemini 3.8 Flash; Grok 4.7; DeepSeek V4.1 Flash; Kimi K3; Qwen3.8 Max Prime; GLM 5.3; Muse Spark 1.3; Mistral Large 2512 |
| `provider` | `{ data_collection: "deny" }` | Sent on every chat call, like Jev and System 2 |
| `effort` | `low` | `reasoning.effort`, so replies start quickly; models without reasoning ignore it |
| `capUsd` | `2` | The chat spend cap per recording (below) |
| `timeoutMs`, `maxAttempts` | `120000`, `2` | A failure before the first word is retried once; a reply already streaming is never retried |

Each model's facts come from OpenRouter's catalogue (`GET https://openrouter.ai/api/v1/models`), read by the engine and kept for an hour (a failed read is retried after a minute):

- the context window (`context_length`);
- the input, output, and cached-input price per million tokens (`pricing.*` × 10⁶);
- whether it is still listed (`available: false` greys it out).

The base price is shown. Some models charge more above a prompt size (OpenRouter's `pricing.overrides`), and the recorded cost is always OpenRouter's actual figure.

The model can be changed at any time. The next question sends the whole conversation to the new model, without its cache.

Tested on 26 September 2026: GPT-6 Luna and Claude Sonnet 5 both route with `data_collection: deny`. If no provider of a model accepts it, OpenRouter answers 404 and the chat says so ("No provider of … accepts this project's privacy setting").

## Storage — `chats.jsonl`

Each session folder gets `chats.jsonl`, append-only like every other file (see [Recordings](recordings.md)). Rows:

| `kind` / `op` | Holds |
| --- | --- |
| `chat` `create` | `chat_id` (`chat_<n>`), `title` ("New chat"), `model` |
| `chat` `rename` | New `title`; `auto: true` for the title taken from the first question (first 60 characters) |
| `chat` `model` | New `model` |
| `chat` `rewind` | `keep`: later messages are dropped (an edit or a regeneration) |
| `chat` `delete` | The chat leaves the list; its spend stays in the recording's total |
| `chat_message` | `id` (`m_<n>`), `role`, `content`, `model`. A question also keeps `sent` (exactly what the model received, transcript included) and `lines` (`from`, `to`, `upToMs`, `live`, `names`); a reply may have `stopped` or `error` |
| `chat_call` | One per reply: tokens (prompt, completion, reasoning, cached), `cost_usd`, latency, attempts, the generation id, and the returned model and provider; `stopped`, `estimated`, `error` when they apply |

Chats can be made on a recording opened from the library. This is the second exception to "an opened recording is read-only", after speaker edits.

## Cost

- **Every reply's cost** comes from the stream's final `usage` (`usage: { include: true }`).
- **A stopped reply** has no final usage, so the engine asks OpenRouter's generation record (`GET /api/v1/generation?id=`, up to 3 tries 1–3 s apart). Only if that fails is the cost estimated from the price list (about 4 characters per token), marked `estimated` and shown with a `*`.
- **The session's ledger:** during a session, chat spend goes into the budget's fourth bucket, `chat` (`src/budget.ts`). The header's spend and its hover breakdown include it (Transcription, Jev, System 2, Chat).
- **The session cap ignores chat.** It counts only transcription, Jev, and System 2, so a long chat on air can never stop fact-checking.
- **Chat's own cap:** `chat.capUsd` ($2) per recording, summed over its `chat_call` rows, deleted chats included. When it is reached, questions are refused (409) and the composer says so.
- **A recording's cost** includes its chats (`SessionSummary.cost.chat`), so the header shows "what it cost when it ran, plus any chats about it". A chat on an opened recording emits a transient `cost` event with the recording's new totals.
- **The development total:** `chat_call` counts toward it (`sumDevSpend`), but the development cap is not enforced on chat.
- **A 402 from OpenRouter** marks a running session's budget exhausted, as for any other call.

## API

All of these act on the session on screen; with none, they answer 409 (the list is empty).

| Method | Route | Does |
| --- | --- | --- |
| GET | `/api/chat/models` | `{ default, capUsd, models: [{ id, name, contextLength, maxOutput, inputUsdPerM, outputUsdPerM, cacheReadUsdPerM, available }] }` |
| GET | `/api/chats` | `{ sessionId, chats: [{ id, title, model, updatedAt, busy, messages, costUsd }], spentUsd, capUsd }`, newest first |
| POST | `/api/chats` | `{ model? }` → a new chat (nothing is sent) |
| GET, PATCH, DELETE | `/api/chats/:id` | The chat with its messages (without `sent`) and `meter`; PATCH `{ title?, model? }`; DELETE |
| POST | `/api/chats/:id/messages` | `{ content, mode?: "send" \| "edit" }` or `{ mode: "regenerate" }`. Validation errors are JSON (400, 404, 409); otherwise the response is a server-sent event stream: `start` (the question as saved, the reply's id), `thinking`, `delta`… , then `done` with the saved reply, the call row, and the updated chat (an `error` event comes before `done` when the reply failed) |
| POST | `/api/chats/:id/stop` | Stops the reply being written; what was written is kept |

- **edit** replaces the last question and its reply. The new question brings every line said since the question before it.
- **regenerate** asks the last question again exactly as it was sent.
- One reply at a time per chat (409 otherwise).
- If the page leaves mid-reply, the reply still completes and is saved. A chat reports `busy` meanwhile, and the page checks back every 2 s.

The **meter** (`GET /api/chats/:id`):

- `contextTokens` is the conversation's size at its latest reply, and `leftTokens` is the window minus that.
- `inputTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens`, and `costUsd` are totals over every reply. Each question re-sends the conversation, so input grows faster than the conversation does.
- `pendingLines` and `pendingTokens` are the transcript lines the next question will bring, with a token estimate.

## The page — `web/src/chat.ts`, `web/src/markdown.ts`

**Where it opens.** The header's **Chat** button sits after Stop, behind a separator, before Replay and the cog.

- It is an icon button, the size of Replay and the cog, because on air the header already carries two stream meters, the cost, the microphone and people pickers, and Start, Pause, and Stop; its "Chat" label shows only on screens 1500 px and wider.
- It is outlined in the accent colour. That ranks it above the two grey utilities, but below Start live (solid) and Stop, which run the show.
- Its tooltip names the shortcut, ⌘K / Ctrl+K, which opens the chat from anywhere.
- A pulsing dot on it means a reply is being written.

**Without an OpenRouter key** the window shows "Please provide your OpenRouter API key to use Chat." with the key's card in place of the chat (`#chat-key`, inside the dialog); saving the key opens the chat. The chat's POST routes answer 400 `needsKey: "openrouter"` without the key, before calling OpenRouter (see [Setup](setup.md#asking-for-a-key-where-it-is-needed)).

**The window** (`dlg-chat`, up to 1240 × 1000 px, 92 % of the window's height). Its header names what the chat is about ("About Episode 12 · on air"). A cited time plays a recording from there with the chat left open; on air, it closes the chat and scrolls the transcript to that line.

- **Sidebar**, as in ChatGPT:
  - **+ New chat**, then this recording's chats, newest first, each with its model and cost; Rename and Delete appear on hover.
  - At the bottom, the recording's chat spend against the cap, with a bar.
- **Top bar:** the model picker, and the chat's title.
- **Messages:**
  - A question is a right-aligned strap with a chip saying what it carried ("Transcript · 120 lines · up to 10:12", "+44 new lines", "no new lines").
  - A reply streams in as it is written. It shows typing dots, and "Thinking…" while a reasoning model reasons, before the first word.
  - Replies render as Markdown (paragraphs, headings, lists, quotes, code, tables, bold, italic, links). The renderer is hand-written, needs no dependency, and builds DOM nodes rather than HTML, so a reply cannot inject markup. Cited `[m:ss]` times are yellow buttons.
  - Actions: Copy on every message. Edit on the last question (or ↑ in an empty box), which edits in place. Regenerate on the last reply, which reads Retry after an error.
- **Empty chat:** a short explanation and four starter questions.
- **Meter** (above the composer): a context bar ("31k of 1.05M · 1.02M left"); input (cached), output (thinking), this chat's cost, and the recording's chat spend against the cap. Then, on air, "Your next question brings N new lines (about T tokens)", refreshed at most every 4 s while the window is open.
- **Composer:**
  - The question box grows up to 200 px. Enter sends, Shift+Enter adds a line, and Esc stops a reply.
  - Send becomes Stop while a reply is written.
- **Model picker:** shows the current model with its context window and price per million tokens. It opens a panel with:
  - **Search** by name, vendor, or id. ↑ and ↓ move through the results, Enter picks, and Esc closes.
  - **Sort:**
    - Suggested: the order of `chat.models`.
    - Cheapest and Priciest: by input price, then output, because a transcript chat is mostly input (each question re-sends the conversation).
    - Largest context.
    - The choice is remembered in the browser.
  - A table of every model: context, input price, and output price. A model OpenRouter no longer lists is greyed out.
- The messages and the composer are centred in a column at most about 820 px wide, for reading.
- **URL:** `?panel=chat&chat=chat_2` (see [Architecture](architecture.md)).

Related: [Architecture](architecture.md), [Recordings](recordings.md), [Mission](mission.md).
