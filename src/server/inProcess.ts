// The Mac app's connection to the engine: no socket and no port. Each request from the window (a web `Request` on
// the app's private `app://` scheme) goes to the same router `npm run serve` listens with, over an in-memory stream
// pair, and its response streams back as a web `Response`: JSON, server-sent events, Range audio, uploads, downloads.
// See docs/desktop.md.
import { request as httpRequest, type Server } from "node:http";
import { duplexPair, Readable } from "node:stream";

export function inProcessHandler(server: Server): (req: Request) => Promise<Response> {
  return (req) => {
    const url = new URL(req.url);
    const [client, side] = duplexPair();
    // a pair does not pass a close across: without this, a page closing its event stream would leave the router
    // subscribed and writing to it for good
    client.once("close", () => side.destroy());
    side.once("close", () => client.destroy());
    server.emit("connection", side);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    // Only the app's own window reaches this handler, so it is the page itself: the router's check for the setup
    // routes (a Host of this machine, and an Origin that matches it) is given exactly that.
    headers.host = "127.0.0.1";
    delete headers.origin;
    headers.connection = "close"; // one pair per request, closed when its response ends
    return new Promise((resolve, reject) => {
      const out = httpRequest({ createConnection: () => client as never, method: req.method, path: url.pathname + url.search, headers }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 500;
        const empty = status === 204 || status === 304 || req.method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
      });
      out.on("error", reject);
      if (req.body) Readable.fromWeb(req.body as never).on("error", (e) => out.destroy(e)).pipe(out);
      else out.end();
    });
  };
}
