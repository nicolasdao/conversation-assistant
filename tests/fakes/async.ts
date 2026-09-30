/** A promise with its resolve and reject outside, for ordering and concurrency tests. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
export const flushMicrotasks = async (times = 5): Promise<void> => { for (let i = 0; i < times; i++) await Promise.resolve(); };
