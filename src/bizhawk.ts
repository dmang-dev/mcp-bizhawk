// mcp-bizhawk Node.js side
// ────────────────────────
// Hosts a TCP server that BizHawk's Lua bridge connects out to. Each frame
// the Lua script does ONE round-trip:
//
//   Lua → us:  "READY\n"             (no pending result)
//          OR  "RESULT <json>\n"      (carrying back the previous frame's result)
//   us → Lua:  "NONE\n"               (nothing pending)
//          OR  "<json command>\n"     (next queued command)
//
// MCP tool calls land via call(method, params) → we enqueue the command and
// resolve the returned promise once the matching RESULT comes back. Each
// command therefore takes at minimum ~one frame (~16ms at 60fps) of latency.

import net from "node:net";

interface PendingCmd {
  id:      number;
  method:  string;
  params:  Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject:  (err: Error) => void;
}

export interface BizhawkOptions {
  /** TCP host to listen on. Default 127.0.0.1. */
  host?: string;
  /** TCP port the BizHawk Lua bridge will dial. Default 8766. */
  port?: number;
  /** Per-call timeout (ms). Default 10000. */
  timeoutMs?: number;
}

export class BizhawkServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private buf = "";
  private queue: PendingCmd[] = [];
  /** Commands sent to BizHawk awaiting a RESULT reply. Keyed by command id. */
  private inflight = new Map<number, PendingCmd>();
  /** True between sending a command and receiving its reply. Lua only handles
   *  one command per round-trip, so we wait for a RESULT before sending the
   *  next command. */
  private awaitingResult = false;
  private nextId = 1;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(opts: BizhawkOptions = {}) {
    this.host      = opts.host      ?? "127.0.0.1";
    this.port      = opts.port      ?? 8766;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  describeTarget(): string {
    return `tcp listening on ${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  /**
   * True once we've received at least one message (READY or RESULT) from the
   * bridge. A bare TCP connection isn't enough — BizHawk's CLI flag opens the
   * socket at process startup, but `bridge.lua` only starts polling after the
   * user loads it via Tools > Lua Console. Tools should wait for this before
   * issuing commands.
   */
  isBridgeReady(): boolean {
    return this.bridgeReady;
  }
  private bridgeReady = false;

  /** Start listening. Resolves once the listen socket is bound. */
  async start(): Promise<void> {
    if (this.server) return;
    return new Promise<void>((resolve, reject) => {
      const srv = net.createServer((sock) => this.attachClient(sock));
      srv.once("error", (err) => reject(err));
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        resolve();
      });
    });
  }

  stop(): void {
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    this.server = null;
  }

  private attachClient(sock: net.Socket): void {
    if (this.client && !this.client.destroyed) {
      // Already have a client. Refuse the new one — only one BizHawk at a time.
      sock.write("ERROR another BizHawk client already connected\n");
      sock.destroy();
      return;
    }
    process.stderr.write("[mcp-bizhawk] BizHawk client connected (waiting for bridge.lua to start polling)\n");
    this.client = sock;
    this.buf = "";
    this.awaitingResult = false;
    this.bridgeReady = false;

    // CRITICAL: disable Nagle. Bridge's socketServerResponse has a 5ms timeout;
    // our 5-byte NONE replies get coalesced by Nagle for up to 200ms otherwise,
    // missing every receive window. With Nagle off, writes flush immediately.
    sock.setNoDelay(true);

    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("close", () => {
      process.stderr.write("[mcp-bizhawk] BizHawk client disconnected\n");
      this.client = null;
      // Leave inflight commands hanging — they'll time out cleanly.
    });
    sock.on("error", (err) => {
      process.stderr.write(`[mcp-bizhawk] socket error: ${err.message}\n`);
    });
  }

  private onData(chunk: string): void {
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] RX raw (${chunk.length}B): ${JSON.stringify(chunk)}\n`);
    }
    this.buf += chunk;
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      let line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;

      // BizHawk's SocketServer.SendString prepends every outgoing message
      // with "<byte-count> " as a framing header. Strip it.
      const m = line.match(/^(\d+) (.+)$/);
      if (m) line = m[2];

      if (process.env.MCP_BIZHAWK_DEBUG) {
        process.stderr.write(`[trace] RX line: ${JSON.stringify(line)}\n`);
      }
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    if (!this.bridgeReady) {
      this.bridgeReady = true;
      process.stderr.write("[mcp-bizhawk] bridge.lua is polling — bridge ready\n");
    }
    if (line === "READY") {
      // Lua is asking for work; no result to deliver this round.
      this.maybeDispatchNext();
      return;
    }
    if (line.startsWith("RESULT ")) {
      const json = line.slice(7);
      let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        process.stderr.write(`[mcp-bizhawk] bad RESULT json: ${(err as Error).message}\n`);
        this.awaitingResult = false;
        this.maybeDispatchNext();
        return;
      }
      const id = parsed.id ?? -1;
      const pending = this.inflight.get(id);
      if (pending) {
        this.inflight.delete(id);
        if (parsed.error) {
          pending.reject(new Error(`BizHawk RPC error [${parsed.error.code}]: ${parsed.error.message}`));
        } else {
          pending.resolve(parsed.result);
        }
      }
      this.awaitingResult = false;
      this.maybeDispatchNext();
      return;
    }
    process.stderr.write(`[mcp-bizhawk] unrecognised line from BizHawk: ${line}\n`);
    this.maybeDispatchNext();
  }

  /**
   * Write a single message to the bridge. BizHawk's socket server, since
   * 2.6.2, requires INCOMING messages to be length-prefixed the same way it
   * frames its OUTGOING ones: `"{length:D} {message}"`. Without the prefix,
   * BizHawk's parser silently discards the line and `socketServerResponse()`
   * returns empty — which is exactly the failure mode we hit before finding
   * this in `Lua/_docs_luacats/comm.d.lua`.
   */
  private sendFramed(payload: string): void {
    if (!this.client || this.client.destroyed) return;
    // length = byte count of the payload itself (not including the framing
    // prefix or the trailing newline that delimits the line on the wire).
    const byteLen = Buffer.byteLength(payload, "utf8");
    const wire = `${byteLen} ${payload}\n`;
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] TX: ${JSON.stringify(wire)}\n`);
    }
    this.client.write(wire);
  }

  /**
   * Called when Lua sends READY. We MUST reply to every send because
   * BizHawk's Lua bridge polls `socketServerResponse()` once per frame and
   * expects something there — and we want to keep the round-trip turning
   * even when there's no work. Reply with the next queued command if
   * available, otherwise NONE.
   */
  private maybeDispatchNext(): void {
    if (!this.client || this.client.destroyed) return;
    if (this.awaitingResult) {
      // a command is in flight; tell bridge to keep waiting
      this.sendFramed("NONE");
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.sendFramed("NONE");
      return;
    }
    this.inflight.set(next.id, next);
    this.awaitingResult = true;
    const msg = JSON.stringify({ id: next.id, method: next.method, params: next.params });
    this.sendFramed(msg);
  }

  /** Enqueue a command and return a promise that resolves when BizHawk replies. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const pending: PendingCmd = {
        id,
        method,
        params,
        resolve: (r) => resolve(r as T),
        reject,
      };

      const timer = setTimeout(() => {
        // Drop from queue if still waiting; from inflight if already sent.
        this.queue   = this.queue.filter((p) => p.id !== id);
        this.inflight.delete(id);
        if (this.inflight.size === 0) this.awaitingResult = false;
        reject(new Error(
          `BizHawk call "${method}" timed out (${this.timeoutMs}ms) — ` +
          `is the bridge.lua script still polling?`,
        ));
      }, this.timeoutMs);

      // Wrap so the timer always clears
      const origResolve = pending.resolve, origReject = pending.reject;
      pending.resolve = (r) => { clearTimeout(timer); origResolve(r); };
      pending.reject  = (e) => { clearTimeout(timer); origReject(e); };

      this.queue.push(pending);
    });
  }
}
