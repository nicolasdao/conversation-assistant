import type { SocketLike } from "../../src/transcribe/live.ts";

export class FakeSocket implements SocketLike {
  readyState = 1;
  sent: any[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.onclose?.({ code: 1000 }); }
  server(e: unknown) { this.onmessage?.({ data: JSON.stringify(e) }); }
  get appends() { return this.sent.filter((m) => m.type === "input_audio_buffer.append"); }
}
