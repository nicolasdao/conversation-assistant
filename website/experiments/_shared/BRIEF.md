# Website experiments: the shared brief

Ten design experiments for a one-page website for **Tattle**. Each explores a different way to make the page fun, interactive, and memorable. All of them share the app's theme. This brief is what every experiment was built from.

## The page's job

People arrive from Google or a social-media post. Within one screen they must understand what the app is and see a big **Download for Mac** button **at the very top**, which downloads the DMG. Everything else on the page exists to make them want to press it.

## The theme (fixed)

Use `_shared/theme.css`, which carries the app's tokens from `web/styles.css` ("On Air: broadcast-graphics look"). You may add fonts from Google Fonts, but use no colours outside these tokens (you may use them at any opacity, and mix them in gradients).

- Background: dark navy `--ground #0a1628` with panel shades `--deck`, `--deck-2`, `--deck-3` and rules `--rule`.
- Text: `--ink #f3f6fa`, `--ink-2`, `--mute`. A white strap, `--paper`, carries `--paper-ink` text.
- Accent: cyan `--accent #2bd4f0`. Live red `--live #e8263b` means "on air" and "recording".
- Verdicts: supported `--good #1db86a`, misleading `--warn #f29422`, contradicted `--bad #e8263b`, unverifiable `--neutral #6a7d98`.
- Voices: host `--host #8cb4ff` (your microphone) and remote `--remote #ff93c0` (the call). Timeline signals: `--heat #ff6b3d`, `--hype #ffd23f`, plus subject and mode colours.
- Type: Barlow for body text, and Barlow Condensed at weights 700–800, UPPERCASE with 0.06–0.16em letter-spacing, for labels, headlines and buttons.
- Shapes:
  - Nearly square corners (2px).
  - Broadcast straps cut as parallelograms, with a 14px slant on the right edge (`clip-path: polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)`).
  - An ON AIR block: red, with a pulsing white dot. It wipes in behind a light sweep.
  - Verdicts styled as TV lower thirds: a coloured slanted block with the verdict word, then the claim.
  - Diagonal stripes (`repeating-linear-gradient(135deg, …)`) for "researching".
  - Segmented level meters that blend green to yellow to red.
- The app icon: a red rounded square (`--icon-top` → `--icon-bottom`) with a white record dot and a faint white ring (`.ca-mark`).

## The download (fixed)

Include `_shared/theme.css` and `_shared/download.js`. Every download link is `<a data-download href="https://github.com/nicolasdao/tattle/releases/latest">`. The script points it at the DMG, fills `[data-version]` and `[data-size]`, and dispatches `ca:download` on click. On a phone or PC, `[data-when="other"]` shows instead of `[data-when="mac"]`: "It's a Mac app. Open this page on your Mac to download it", with a `[data-copy-link]` button and a link to GitHub. Under the button, a meta line: *Apple Silicon · macOS 14.2 or later · Free and open source*.

## What's true about the app (use only this)

- **Tattle** is an open-source Mac app that **transcribes live conversations** (your microphone and the call your Mac plays), **maps them on a timeline**, and **fact-checks claims as they're said**.
- It was built for a live podcast: the host's microphone plus the guests on the call. It works with any call app, because it listens to the Mac's own audio.
- The transcript streams as people speak. Each voice is recognised as a speaker, whom you can name.
- The timeline lanes: topic, mode (news, analysis, personal story, explainer, banter), heat and hype, disagreements, hot takes, predictions, recommendations, and clip-worthy moments.
- Fact-checks: sourced verdicts on screen within seconds. The verdicts are Supported, Contradicted, Misleading, and Unverifiable. System 1 (Jev, a fast decision model, about 0.4 s a judgment, about 2,000 judgments an hour for cents) flags checkable claims. System 2 (a slower LLM that researches the web) checks them and makes System 1 better.
- Chat about the transcript (⌘K), live or afterwards.
- A recordings library. Play back at up to 4×, and export a recording as one file to send.
- Privacy: no server, no account, no analytics. Recordings and keys stay on your Mac.
- Signed and notarized by Apple. It updates itself. BSD 3-Clause.
- Setup: it needs two API keys, from OpenAI and OpenRouter, with prepaid credit, and the app walks you through both. It costs about $1.60 per hour of show, or about $1.23 for a transcript only. **Do not claim it is free to run or needs no keys.**
- Requirements: Apple Silicon, macOS 14.2 or later.

Example claims for demos (verdicts that are safe and true):

| Claim | Verdict | Note |
| --- | --- | --- |
| "The Great Wall of China is visible from space with the naked eye." | Contradicted | Astronauts report it isn't. |
| "Bananas are berries." | Supported | Botanically, yes. |
| "Goldfish only have a three-second memory." | Contradicted | They remember for months. |
| "Lightning never strikes the same place twice." | Contradicted | The Empire State Building is hit about 20–25 times a year. |
| "Mount Everest gets a little taller every year." | Supported | A few millimetres a year. |
| "Coffee dehydrates you." | Misleading | Its water outweighs the mild diuretic effect. |
| "Bats are blind." | Contradicted | All bats can see. |
| "Honey found in Egyptian tombs was still edible." | Supported | |
| "The average person swallows eight spiders a year in their sleep." | Contradicted | |
| "Octopuses have three hearts." | Supported | |

Banter lines (not claims) include "Okay, enough about models, how was surfing in Sydney this weekend?" and "I don't buy that at all, cheap is not the same as good."

## Craft rules

- The first frame, before any scrolling, shows: the name, what it does in one line, the Download button, and the experiment's signature interaction already alive. It must also look right as a still screenshot.
- Phones (390px wide) get a real layout. No horizontal scroll, and the non-Mac download state shows.
- Respect `prefers-reduced-motion` (`CA.reducedMotion`) with a calm version. Pause animation loops when the tab is hidden or the element is off screen. Cap the device pixel ratio at 2.
- Libraries: only when they do real work. Load them from cdnjs or jsdelivr with pinned versions (for example `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js` through an import map, `gsap/3.12.5`, `matter-js/0.20.0`).
- No emoji, no lorem ipsum, no stock gradients, no generic SaaS sections. Buttons use plain, direct words.
- Include `<a class="ca-back" href="../">All experiments</a>`.
