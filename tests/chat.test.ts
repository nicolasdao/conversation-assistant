import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Budget } from "../src/budget.ts";
import { ChatService, composeQuestion, type ChatEvent, type ChatSource, type TranscriptLine } from "../src/chat/chat.ts";
import { fakeOpenRouter } from "./fakes/index.ts";

const cfg = loadConfig().app.chat;
const line = (n: number, speakerId = "spk_1", speaker = "Speaker 1"): TranscriptLine =>
  ({ id: `u_${n}`, startMs: n * 10_000, speakerId, speaker, text: `line ${n}` });

describe("composing a question", () => {
  test("the first question carries the whole transcript so far; later ones only the new lines", () => {
    const first = composeQuestion(undefined, [line(1), line(2)], true, "What was said?");
    expect(first.sent).toContain('<transcript status="live, still being recorded" lines="2" up_to="0:20">');
    expect(first.sent).toContain("[0:10] Speaker 1: line 1\n[0:20] Speaker 1: line 2");
    expect(first.sent).toMatch(/<question>\nWhat was said\?\n<\/question>$/);
    expect(first.lines).toMatchObject({ from: 0, to: 2, upToMs: 20_000, live: true });

    const second = composeQuestion(first.lines, [line(1), line(2), line(3)], true, "And then?");
    expect(second.sent).toContain('<transcript_update lines="3–3" up_to="0:30">\n[0:30] Speaker 1: line 3\n</transcript_update>');
    expect(second.sent).not.toContain("line 1");
    expect(second.lines).toMatchObject({ from: 2, to: 3 });

    const third = composeQuestion(second.lines, [line(1), line(2), line(3)], true, "Anything new?");
    expect(third.sent).toContain("No new lines since the previous question.");
    expect(third.lines.upToMs).toBe(30_000);
  });

  test("announces renamed speakers and the recording ending", () => {
    const first = composeQuestion(undefined, [line(1)], true, "q1");
    const renamed = [{ ...line(1), speaker: "Alice" }, { ...line(2), speaker: "Alice" }];
    const next = composeQuestion(first.lines, renamed, false, "q2");
    expect(next.sent).toContain('<speaker_names>"Speaker 1" in earlier lines is now called "Alice".</speaker_names>');
    expect(next.sent).toContain("The recording has ended.");
    expect(next.lines.names).toEqual({ spk_1: "Alice" });
  });

  test("an empty recording says so", () => {
    expect(composeQuestion(undefined, [], false, "q").sent).toContain('<transcript status="finished">No one has spoken yet.</transcript>');
  });
});

function setup(lines: TranscriptLine[], opts: { budget?: Budget; live?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  const or = fakeOpenRouter();
  let spends = 0;
  const source: ChatSource = { sessionId: "20260926-100000", dir, live: opts.live ?? true, lines: () => lines, budget: opts.budget };
  const svc = new ChatService(cfg, { fetch: or.fetchFn, apiKey: "sk-test", source: () => source, onSpend: () => spends++, sleep: async () => {} });
  const ask = async (id: string, body: { content?: string; mode?: string }) => {
    const events: ChatEvent[] = [];
    await svc.prepare(id, body)((e) => events.push(e));
    return events;
  };
  return { dir, svc, or, ask, spends: () => spends };
}

describe("chat service", () => {
  test("models come from the catalogue with context window and price per million tokens", async () => {
    const { svc } = setup([]);
    const m = await svc.models();
    expect(m.default).toBe("openai/gpt-6-luna");
    expect(m.models[0]).toMatchObject({ id: "openai/gpt-6-luna", contextLength: 1_050_000, inputUsdPerM: 0.1, outputUsdPerM: 0.5, available: true });
    expect(m.models.find((x) => x.id === "openai/gpt-6-sol")?.available).toBe(false); // not in the fake catalogue
  });

  test("a new chat spends nothing until its first question", async () => {
    const { svc, or } = setup([line(1)]);
    const c: any = await svc.create();
    expect(c).toMatchObject({ id: "chat_1", title: "New chat", model: "openai/gpt-6-luna", messages: [] });
    expect(or.bodies).toHaveLength(0);
    expect(svc.list()).toMatchObject({ spentUsd: 0, chats: [{ id: "chat_1" }] });
  });

  test("streams a reply, records its cost, and sends only new lines with the next question", async () => {
    const lines = [line(1), line(2)];
    const budget = new Budget();
    const { svc, or, ask, dir, spends } = setup(lines, { budget });
    await svc.create();
    const ev = await ask("chat_1", { content: "Who spoke first?" });
    expect(ev.map((e) => e.type)).toEqual(["start", "delta", "delta", "delta", "delta", "done"]);
    const done = ev.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(done.message).toMatchObject({ role: "assistant", content: "Alice said [0:10] hello." });
    expect(done.call).toMatchObject({ kind: "chat_call", ok: true, cost_usd: 0.0012, provider_returned: "OpenAI" });
    expect((done.chat as any).title).toBe("Who spoke first?");
    expect((done.chat as any).meter).toMatchObject({ contextTokens: 128, leftTokens: 1_050_000 - 128, costUsd: 0.0012, pendingLines: 0 });
    expect(budget.totals().chat).toBeCloseTo(0.0012);
    expect(spends()).toBe(1);

    const req = or.bodies[0];
    expect(req).toMatchObject({ model: "openai/gpt-6-luna", stream: true, usage: { include: true }, provider: { data_collection: "deny" } });
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[1].content).toContain("[0:20] Speaker 1: line 2");

    lines.push(line(3));
    expect(((await svc.chat("chat_1")) as any).meter.pendingLines).toBe(1);
    await ask("chat_1", { content: "And after?" });
    const second = or.bodies[1].messages;
    // the earlier conversation is re-sent byte for byte, so the provider's prompt cache can serve it
    expect(second.slice(0, 3)).toEqual([...req.messages, { role: "assistant", content: "Alice said [0:10] hello." }]);
    expect(second[3].content).toContain('<transcript_update lines="3–3"');
    expect(second[3].content).not.toContain("line 2");

    const rows = readFileSync(join(dir, "chats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.kind === "chat_call")).toHaveLength(2);
    expect(svc.list().spentUsd).toBeCloseTo(0.0024);
  });

  test("editing the last question replaces it and its reply; regenerating re-asks it as sent", async () => {
    const lines = [line(1)];
    const { svc, or, ask } = setup(lines);
    await svc.create();
    await ask("chat_1", { content: "First" });
    lines.push(line(2));
    await ask("chat_1", { content: "Second" });
    await ask("chat_1", { content: "Second, reworded", mode: "edit" });
    const c: any = await svc.chat("chat_1");
    expect(c.messages.map((m: any) => m.content)).toEqual(["First", "Alice said [0:10] hello.", "Second, reworded", "Alice said [0:10] hello."]);
    // the edited question still brings the lines said since the first one
    expect(or.bodies[2].messages.at(-1).content).toContain("[0:20] Speaker 1: line 2");

    await ask("chat_1", { mode: "regenerate" });
    expect(or.bodies[3].messages).toEqual(or.bodies[2].messages);
    expect(((await svc.chat("chat_1")) as any).messages).toHaveLength(4);
  });

  test("no spending cap: questions keep going whatever the recording's chat has spent", async () => {
    const { svc, ask } = setup([line(1)]);
    await svc.create();
    await ask("chat_1", { content: "q" });
    expect(svc.list().spentUsd).toBeGreaterThan(0);
    expect(() => svc.prepare("chat_1", { content: "again" })).not.toThrow();
  });

  test("renames, model changes, and deletes are appended; unknown models are refused", async () => {
    const { svc } = setup([]);
    await svc.create();
    expect(await svc.update("chat_1", { title: "Claims", model: "anthropic/claude-sonnet-5" })).toMatchObject({ title: "Claims", model: "anthropic/claude-sonnet-5" });
    await expect(svc.update("chat_1", { model: "nobody/nothing" })).rejects.toThrow(/unknown model/);
    svc.remove("chat_1");
    expect(svc.list().chats).toHaveLength(0);
    await expect(svc.chat("chat_1")).rejects.toThrow(/unknown chat/);
  });
});
