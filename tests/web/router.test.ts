// @vitest-environment happy-dom
// The page's URLs (web/src/router.ts), beyond tests/router.test.ts: the edge cases of the pure functions, and setRoute
// against a real location and history.
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildUrl, formatTime, PANELS, panelName, parseTime, readRoute, setRoute, tabName, TABS } from "../../web/src/router.ts";

const at = (url: string) => { const u = new URL(url, "http://x"); return readRoute({ pathname: u.pathname, search: u.search }); };
const url = () => `${location.pathname}${location.search}`;

afterEach(() => { vi.restoreAllMocks(); history.replaceState(null, "", "/"); });

describe("times", () => {
  test("parseTime: nothing is null, a negative or non-number part is null, fractions and empty parts are lenient", () => {
    expect([parseTime(null), parseTime(""), parseTime("-1"), parseTime("1:-2"), parseTime("1:x")]).toEqual([null, null, null, null, null]);
    expect([parseTime("1.5"), parseTime("1::2"), parseTime("0")]).toEqual([1500, 3_602_000, 0]);
  });

  test("formatTime clamps below zero, floors to the second, and adds hours past one", () => {
    expect([formatTime(-5000), formatTime(59_999), formatTime(61_000), formatTime(3_600_000), formatTime(36_061_000)])
      .toEqual(["0:00", "0:59", "1:01", "1:00:00", "10:01:01"]);
  });
});

describe("names", () => {
  test("tabName and panelName map ids back to names, and null for unknown ones", () => {
    for (const [name, id] of Object.entries(TABS)) expect(tabName(id)).toBe(name);
    for (const [name, id] of Object.entries(PANELS)) expect(panelName(id)).toBe(name);
    expect([tabName("pane-x"), panelName("dlg-x")]).toEqual([null, null]);
  });
});

describe("readRoute and buildUrl edges", () => {
  test("a recording id may end in a slash; it must start with a letter or digit and use only letters, digits, _ and -", () => {
    expect(at("/recordings/abc_1-2/").recording).toBe("abc_1-2");
    for (const bad of ["/recordings/-x", "/recordings/_x", "/recordings/a.b", "/recordings/a%20b", "/recordings/", "/recordings/a/b"]) {
      expect(at(bad).recording).toBeNull();
    }
  });

  test("the position means nothing on /, and a chat must look like chat_<n>", () => {
    expect(at("/?t=10").t).toBeNull();
    expect(at("/recordings/a?t=10").t).toBe(10_000);
    expect([at("/?panel=chat&chat=chat_").chat, at("/?panel=chat&chat=Chat_1").chat, at("/?panel=chat&chat=chat_12").chat]).toEqual([null, null, "chat_12"]);
  });

  test("buildUrl leaves out a position of 0 or none, the default tab and section, and keeps colons readable", () => {
    const r = { recording: "a", tab: null, panel: null };
    expect(buildUrl({ ...r, t: 0 })).toBe("/recordings/a");
    expect(buildUrl({ ...r, t: null })).toBe("/recordings/a");
    expect(buildUrl({ ...r, t: 83_000 })).toBe("/recordings/a?t=1:23");
    expect(buildUrl({ recording: null, t: null, tab: "fact-check", panel: "insights", section: "overview" })).toBe("/?panel=insights");
    expect(buildUrl({ recording: null, t: null, tab: null, panel: "recordings", chat: "chat_1", section: "log" })).toBe("/?panel=recordings");
  });

  test("buildUrl encodes the recording id", () => {
    expect(buildUrl({ recording: "a b/c", t: null, tab: null, panel: null })).toBe("/recordings/a%20b%2Fc");
  });

  test("readRoute reads the page's own location by default", () => {
    history.replaceState(null, "", "/recordings/x?tab=jev-log");
    expect(readRoute()).toMatchObject({ recording: "x", tab: "jev-log" });
  });
});

describe("setRoute", () => {
  test("replaces the URL by default, and pushes a history entry when asked", () => {
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    setRoute({ tab: "thinking" });
    expect([url(), replace.mock.calls.length, push.mock.calls.length]).toEqual(["/?tab=thinking", 1, 0]);
    setRoute({ recording: "rec1" }, true);
    expect([url(), push.mock.calls.length]).toEqual(["/recordings/rec1?tab=thinking", 1]);
  });

  test("changes nothing when the URL would stay the same", () => {
    history.replaceState(null, "", "/?panel=recordings");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    setRoute({ panel: "recordings" });
    setRoute({ panel: "recordings" }, true);
    expect([push.mock.calls.length, replace.mock.calls.length]).toEqual([0, 0]);
  });

  test("a change of recording resets the position to the patch's, or none", () => {
    history.replaceState(null, "", "/recordings/a?t=1:00&panel=chat&chat=chat_2");
    setRoute({ recording: "b" }, true);
    expect(url()).toBe("/recordings/b?panel=chat&chat=chat_2");
    setRoute({ recording: "c", t: 5000 });
    expect(url()).toBe("/recordings/c?t=0:05&panel=chat&chat=chat_2");
    setRoute({ recording: "c" });
    expect(url()).toBe("/recordings/c?t=0:05&panel=chat&chat=chat_2"); // the same recording keeps its position
  });

  test("a patch keeps the other parts of the URL", () => {
    history.replaceState(null, "", "/recordings/a?t=0:10&tab=jev-log");
    setRoute({ panel: "insights", section: "log" });
    expect(url()).toBe("/recordings/a?t=0:10&tab=jev-log&panel=insights&section=log");
    setRoute({ panel: null });
    expect(url()).toBe("/recordings/a?t=0:10&tab=jev-log");
  });
});
