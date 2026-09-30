import type { loadScript } from "../helpers.ts";

export const TEST_OPENROUTER_KEY = "sk-or-v1-test-openrouter-key-0123456789";
export const TEST_OPENAI_KEY = "sk-proj-test-openai-key-9876543210";

/**
 * A fake of all three services behind fetch. Transcription returns the scripted line by time; Jev flags lines whose
 * script says `claim`, recognises the repeated line, and marks the topic change as a boundary; one Jev call echoes
 * the key in an error body to prove redaction.
 */
export function fakeServicesFetch(script: ReturnType<typeof loadScript>) {
  let transcribeCalls = 0;
  let echoed = false;
  const texts = new Map<string, number>(); // text → line
  for (const l of script.lines) texts.set(l.text, l.line);
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes("audio/transcriptions")) {
      transcribeCalls++;
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const seconds = (file.size - 44) / 32000;
      // match by duration: the closest scripted line
      const line = [...script.lines].sort((a, b) =>
        Math.abs((a.endMs - a.startMs) / 1000 - seconds) - Math.abs((b.endMs - b.startMs) / 1000 - seconds))[0];
      return json({ text: line.text });
    }
    if (url.includes("alpha/decisions")) {
      const body = JSON.parse(init.body as string);
      if (!echoed) {
        echoed = true;
        return json({ error: { code: 401, message: `invalid key ${TEST_OPENROUTER_KEY}` } }, 400);
      }
      const answers: Record<string, unknown> = {};
      const st = body.state;
      const text: string = st.new_utterance?.text ?? "";
      const line = script.lines.find((l) => l.text === text);
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (id === "boundary") answers[id] = { type: "noul", noul: line?.expected.topicChange ? 0.9 : 0.1 };
        else if (id === "claim") answers[id] = { type: "noul", noul: line?.expected.claim ? 0.95 : 0.05 };
        else if (id === "public") answers[id] = { type: "noul", noul: line?.expected.claim ? 0.9 : 0.1 };
        else if (id === "claim_type") answers[id] = { type: "choice", choice: line?.expected.claim ? "number_or_price" : "none", confidence: 0.9, probabilities: {} };
        else if (id === "worth") answers[id] = { type: "score", score: line?.expected.claim ? 3.2 : 0.2, confidence: 0.9, probabilities: {} };
        else if (id.startsWith("known_")) answers[id] = { type: "noul", noul: line?.expected.repeatOf && id === "known_c_1" ? 0.95 : 0.02 };
        else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.2 };
        else if (q.type === "score") answers[id] = { type: "score", score: 1, confidence: 0.9, probabilities: {} };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const segText = JSON.stringify(st.segment ?? "");
          const pick = id === "subject" ? (segText.includes("surf") || segText.includes("Bondi") ? "personal_life" : "ai_models") : keys[0];
          answers[id] = { type: "choice", choice: pick, confidence: 0.8, probabilities: {} };
        }
      }
      return json({ answers, id: "gen-dec-x", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { cost: 0.00002, input_tokens: 400, output_tokens: 10 } });
    }
    if (url.includes("chat/completions")) {
      const body = JSON.parse(init.body as string);
      const schema = body.response_format.json_schema?.name;
      const content = schema === "verdict"
        ? { restated_claim: "A claim.", verdict: "supported", correction: "", confidence: "high", false_alarm_reason: "none", sources: [{ url: "https://example.com/a", title: "A" }] }
        : schema === "audit" ? { items: [] } : { changes: [], rationale: "none" };
      return json({ id: "gen-1", model: "openai/gpt-6-luna", provider: "OpenAI", choices: [{ message: { content: JSON.stringify(content), annotations: [] } }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0003 } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { f: f as unknown as typeof fetch, stats: () => ({ transcribeCalls }) };
}
