import { EventBus } from "../../src/store/events.ts";

/** An event bus that records every event that fails its schema, so a test can assert there were none. */
export function strictBus(redact?: (s: string) => string): { bus: EventBus; invalid: string[] } {
  const invalid: string[] = [];
  const bus = new EventBus({ redact, onInvalid: (t, m) => invalid.push(`${t}: ${m}`) });
  return { bus, invalid };
}
