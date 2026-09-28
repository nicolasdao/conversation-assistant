// Boot: until both API keys are set, the page shows only the setup screen and the app is never loaded (see
// docs/setup.md). Then the app (app.ts) loads GET /api/state and follows GET /api/events.
import { setupStatus, showSetup } from "./keys.js";
import { desktop } from "./desktop.js";

// in the Mac app, what its menu bar already has leaves the page (the .browser-only items: API keys, the menu footer, Replay)
if (desktop) document.body.classList.add("in-app");

const status = await setupStatus();
if (status && !status.configured) showSetup(status);
// the page's shell stays hidden until this is known, so it never flashes before the setup screen
document.body.classList.remove("booting");
if (!status || status.configured) await import("./app.js");
