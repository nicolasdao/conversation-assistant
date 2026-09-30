import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Raw HTTP against a router on 127.0.0.1 (tests/setup.ts disables fetch): a server that listens on a free port, and
// requests that return the status, headers, text, JSON, and bytes of the answer.

export interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
  /** The body parsed as JSON; null when it is not JSON. */
  json: any;
}

/** Listens on a free port of 127.0.0.1; resolves to the base URL and a close function. */
export async function listen(server: Server): Promise<{ base: string; port: number; close: () => Promise<void> }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`, port,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/**
 * One request. `body` is sent as JSON (with its content type) unless it is a string or a Buffer, which are sent as
 * they are; `headers` add to or replace the defaults.
 */
export function http(base: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpAnswer> {
  const raw = typeof opts.body === "string" || Buffer.isBuffer(opts.body);
  const headers: Record<string, string> = { ...(opts.body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) };
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const text = body.toString("utf8");
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, headers: res.headers, body, text, json });
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(raw ? opts.body as string | Buffer : JSON.stringify(opts.body));
    req.end();
  });
}

/**
 * Opens a server-sent event stream and collects its text; `until(needle)` waits for it to arrive, `close()` hangs up.
 */
export function openStream(base: string, path: string): Promise<{ status: number; headers: Record<string, unknown>; text: () => string; until: (needle: string) => Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const waiters: { needle: string; done: () => void }[] = [];
    const req = request(base + path, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
        for (const w of waiters.splice(0)) (text.includes(w.needle) ? w.done() : waiters.push(w));
      });
      resolve({
        status: res.statusCode!, headers: res.headers, text: () => text,
        until: (needle) => new Promise<void>((done) => (text.includes(needle) ? done() : waiters.push({ needle, done }))),
        close: () => req.destroy(),
      });
    });
    req.on("error", (e) => { if (!req.destroyed) reject(e); });
    req.end();
  });
}
