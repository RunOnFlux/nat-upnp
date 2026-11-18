import http from "http";
import net from "net";

import { decodeXmlEntities } from "./device";

/** One NOTIFY: its subscription, its sequence number, and the variables it carries. */
export interface UpnpEvent {
  readonly sid: string;
  readonly seq: number;
  /** Each evented state variable by name, e.g. PortMappingNumberOfEntries. */
  readonly properties: Readonly<Record<string, string>>;
}

export interface EventListenerOpts {
  /** The only address NOTIFYs are accepted from: anything else on the LAN could otherwise
   *  feed the listener events. */
  gateway: string;
  /** The address to listen on, and the callback's host: the one the router reaches this
   *  host by. */
  host: string;
  /** The port to listen on; 0 picks a free one. */
  port: number;
}

const MAX_NOTIFY_BYTES = 64 * 1024;

/**
 * Receives a router's event NOTIFYs. Answers 403 to any source but the gateway, 405 to
 * any method but NOTIFY, 412 to a NOTIFY without a SID or a sequence number, and 413 to
 * a body over 64 KiB. Whether a NOTIFY's SID is a current subscription's is the caller's
 * to check.
 */
export class EventListener {
  private readonly opts: EventListenerOpts;
  private server: http.Server | null = null;
  private boundPort = 0;

  constructor(opts: EventListenerOpts) {
    this.opts = opts;
  }

  /** The URL to subscribe with; valid once listen() has resolved. */
  get callback(): string {
    const host = net.isIPv6(this.opts.host) ? `[${this.opts.host}]` : this.opts.host;
    return `http://${host}:${this.boundPort}/`;
  }

  listen(onEvent: (event: UpnpEvent) => void): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => this.receive(req, res, onEvent));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (err) => {
        this.server = null;
        reject(err);
      });
      server.listen(this.opts.port, this.opts.host, () => {
        this.boundPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  private receive(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onEvent: (event: UpnpEvent) => void
  ): void {
    const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (from !== this.opts.gateway || req.method !== "NOTIFY") {
      res.writeHead(from !== this.opts.gateway ? 403 : 405).end();
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_NOTIFY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const sid = String(req.headers["sid"] ?? "").trim();
      const seq = Number(req.headers["seq"]);
      if (!sid || !Number.isInteger(seq) || seq < 0) {
        res.writeHead(412).end();
        return;
      }
      res.writeHead(200, { "Content-Length": "0" }).end();
      onEvent({ sid, seq, properties: parseProperties(Buffer.concat(chunks).toString("utf8")) });
    });
  }
}

function parseProperties(body: string): Record<string, string> {
  const properties: Record<string, string> = {};
  const property = /<(?:[\w-]+:)?property\b[^>]*>\s*<(?:[\w-]+:)?([\w.-]+)\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?\1\s*>/g;
  for (const match of body.matchAll(property)) {
    properties[match[1]] = decodeXmlEntities(match[2].trim());
  }
  return properties;
}
