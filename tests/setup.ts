// Tests never call the network (§7): every client takes its fetch through its constructor, and tests pass fakes.
globalThis.fetch = (() => {
  throw new Error("network disabled in tests");
}) as typeof fetch;
