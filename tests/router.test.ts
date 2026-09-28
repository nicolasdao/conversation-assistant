import { describe, expect, test } from "vitest";
import { buildUrl, parseTime, readRoute } from "../web/src/router.ts";

const at = (url: string) => { const u = new URL(url, "http://x"); return readRoute({ pathname: u.pathname, search: u.search }); };

describe("the page's URLs", () => {
  test("a recording, its playback position, tab, and settings window", () => {
    expect(at("/recordings/20260925-202620?t=58:27&tab=thinking&panel=speakers")).toEqual(
      { recording: "20260925-202620", t: (58 * 60 + 27) * 1000, tab: "thinking", panel: "speakers", chat: null, section: null });
    expect(at("/")).toEqual({ recording: null, t: null, tab: null, panel: null, chat: null, section: null });
    // a position means nothing without a recording; unknown tabs and windows are ignored
    expect(at("/?t=1:00&tab=nope&panel=nope")).toEqual({ recording: null, t: null, tab: null, panel: null, chat: null, section: null });
    expect(at("/recordings/../etc")).toMatchObject({ recording: null });
  });

  test("round trip, with readable times", () => {
    expect(buildUrl({ recording: "20260925-202620", t: 5_261_000, tab: "jev-log", panel: null })).toBe("/recordings/20260925-202620?t=1:27:41&tab=jev-log");
    expect(buildUrl({ recording: null, t: 90_000, tab: "fact-check", panel: "recordings" })).toBe("/?panel=recordings");
    expect(parseTime("83")).toBe(83_000);
    expect(parseTime("1:02:03")).toBe(3_723_000);
    expect(parseTime("x")).toBeNull();
    const url = "/recordings/abc?t=12:34&tab=thinking&panel=insights&section=log";
    expect(buildUrl(at(url))).toBe(url);
    expect(buildUrl(at("/?panel=insights&section=overview"))).toBe("/?panel=insights"); // the default tab stays out of the URL
  });

  test("Insights and its tabs, and the former Stats, System 1, and Log windows opening their tab", () => {
    expect(at("/?panel=insights")).toMatchObject({ panel: "insights", section: null });
    expect(at("/?panel=insights&section=fact-checker")).toMatchObject({ panel: "insights", section: "fact-checker" });
    expect(at("/?panel=insights&section=nope")).toMatchObject({ panel: "insights", section: null });
    expect(at("/?panel=speakers&section=log").section).toBeNull();
    expect(at("/?panel=stats")).toMatchObject({ panel: "insights", section: "overview" });
    expect(at("/?panel=system-1")).toMatchObject({ panel: "insights", section: "fact-checker" });
    expect(buildUrl(at("/recordings/abc?panel=log"))).toBe("/recordings/abc?panel=insights&section=log");
  });

  test("a chat, only with the chat window open", () => {
    expect(at("/?panel=chat&chat=chat_3")).toMatchObject({ panel: "chat", chat: "chat_3" });
    expect(at("/?panel=insights&chat=chat_3").chat).toBeNull();
    expect(at("/?panel=chat&chat=../x").chat).toBeNull();
    expect(buildUrl(at("/recordings/abc?tab=thinking&panel=chat&chat=chat_3"))).toBe("/recordings/abc?tab=thinking&panel=chat&chat=chat_3");
  });
});
