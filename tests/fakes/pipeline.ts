import type { Services } from "../../src/pipeline/session.ts";
import type { TranscriptionResult } from "../../src/transcribe/openai.ts";

/** Transcription answers every clip; with both features off nothing else is called. */
export const transcribeOnlyServices = (): Services => ({
  transcribe: async () => ({ ok: true, text: "something was said here", filler: false }) as never,
  ask: async () => { throw new Error("Jev is not called with both features off"); },
  s2: {} as never,
});

/** Transcription that is down for the first `downFor` calls, then answers with `text`. */
export function flaky(downFor: number, failure: TranscriptionResult = { ok: false, error: "TypeError: fetch failed", retryable: true }, text = "words said here") {
  let calls = 0;
  const services = (): Services => ({
    transcribe: async () => (++calls <= downFor ? failure : { ok: true, text, filler: false }),
    ask: async () => { throw new Error("Jev is not called with both features off"); },
    s2: {} as never,
  });
  return { services, calls: () => calls };
}
