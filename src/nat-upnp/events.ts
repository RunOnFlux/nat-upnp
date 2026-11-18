import { EventEmitter } from "events";
import http from "http";
import net from "net";

import { XMLValidator } from "fast-xml-parser";

import { SubscriptionError, decodeXmlEntities, fieldValue, xmlParser, type EventSubscription } from "./device";

/** One NOTIFY: its sequence number and the variables it carries. */
export interface UpnpEvent {
  readonly seq: number;
  /** Each evented state variable by name, e.g. PortMappingNumberOfEntries. */
  readonly properties: Readonly<Record<string, string>>;
}

/** The requests a Subscription makes of the gateway. */
export interface SubscriptionRequests {
  subscribe(callback: string, timeout: number): Promise<EventSubscription>;
  renew(sid: string, timeout: number): Promise<EventSubscription>;
  unsubscribe(sid: string): Promise<void>;
}

export interface SubscriptionOpts {
  /** The addresses NOTIFYs are accepted from: the gateway's. */
  gateway: readonly string[];
  /** The address to listen on and to name in the callback: this host's towards the gateway. */
  host: string;
  /** The port to listen on; 0 picks a free one. */
  port: number;
  /** Seconds to ask the gateway for, at subscribing and at each renewal. */
  timeout: number;
}

const MAX_NOTIFY_BYTES = 64 * 1024;
/** NOTIFYs held while the SUBSCRIBE is unanswered, as its SID is not known yet. */
const MAX_EARLY_EVENTS = 16;
/** Bounds on a connection: only the gateway can open one, but it can stall like any peer. */
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 16;

export interface Subscription {
  on(event: "event", listener: (event: UpnpEvent) => void): this;
  /** The subscription has ended without close(): a renewal was refused, it lapsed
   *  without one being answered, or the listener failed. No event follows. */
  on(event: "lost", listener: (reason: Error) => void): this;
  once(event: "event", listener: (event: UpnpEvent) => void): this;
  once(event: "lost", listener: (reason: Error) => void): this;
}

/**
 * A subscription to the gateway's events, with the listener that receives them. It renews
 * itself at half of each granted lifetime and ends on close() or "lost".
 *
 * Events are emitted on a later tick than the NOTIFY that carried them, so the gateway is
 * answered whatever a listener does, and in the order the gateway numbered them. The
 * NOTIFY the gateway sends on subscribing can arrive before the SUBSCRIBE is answered;
 * it is held until the SID is known, so the first event is never lost.
 *
 * The listener answers the gateway as GENA requires: 400 for a NOTIFY without NT, NTS or
 * a decimal SEQ, or with a body that is not XML; 412 for a wrong NT or NTS, or a SID that
 * is not this subscription's; 413 for a body over 64 KiB. A connection from any other
 * address is closed unanswered.
 */
export class Subscription extends EventEmitter {
  private sidValue = "";
  private granted: number | null = null;
  private expiresAt = 0;
  private renewTimer: NodeJS.Timeout | null = null;
  private early: Array<{ sid: string; event: UpnpEvent }> = [];
  private ended = false;

  private constructor(
    private readonly server: http.Server,
    private readonly requests: SubscriptionRequests,
    private readonly opts: SubscriptionOpts
  ) {
    super();
  }

  /** Listen, then subscribe. Rejects, with nothing left listening, when either fails. */
  static async open(requests: SubscriptionRequests, opts: SubscriptionOpts): Promise<Subscription> {
    const server = http.createServer();
    const sub = new Subscription(server, requests, opts);
    sub.serve();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port, opts.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => sub.lose(err));
    try {
      const callback = `http://${net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host}:${(server.address() as net.AddressInfo).port}/`;
      const granted = await requests.subscribe(callback, opts.timeout);
      sub.sidValue = granted.sid;
      sub.grant(granted);
    } catch (err) {
      sub.ended = true;
      await sub.shutDown();
      throw err;
    }
    const early = sub.early;
    sub.early = [];
    for (const { sid, event } of early) if (sid === sub.sidValue) sub.deliver(event);
    return sub;
  }

  get sid(): string {
    return this.sidValue;
  }

  /** Seconds the gateway last granted; null when it granted "infinite". */
  get timeout(): number | null {
    return this.granted;
  }

  /** UNSUBSCRIBE, then stop listening. Resolves whether or not the gateway answers. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    await this.requests.unsubscribe(this.sidValue).catch(() => {});
    await this.shutDown();
  }

  private grant(granted: EventSubscription): void {
    this.granted = granted.timeout;
    const lifetime = granted.timeout ?? this.opts.timeout;
    this.expiresAt = Date.now() + lifetime * 1000;
    // Renewed even when granted "infinite": a gateway that reboots forgets the
    // subscription, and only a refused renewal says so.
    this.renewIn(Math.max(1000, lifetime * 500));
  }

  private renewIn(ms: number): void {
    this.renewTimer = setTimeout(() => void this.renew(), ms);
  }

  private async renew(): Promise<void> {
    if (this.ended) return;
    try {
      const granted = await this.requests.renew(this.sidValue, this.opts.timeout);
      if (!this.ended) this.grant(granted);
    } catch (err) {
      if (this.ended) return;
      const left = this.expiresAt - Date.now();
      // A refusal ends the subscription; no answer leaves it standing until it lapses.
      if (err instanceof SubscriptionError) return this.lose(err);
      if (left <= 1000) return this.lose(err instanceof Error ? err : new Error(String(err)));
      this.renewIn(Math.max(1000, left / 2));
    }
  }

  private lose(reason: Error): void {
    if (this.ended) return;
    this.ended = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    void this.shutDown();
    setImmediate(() => this.emit("lost", reason));
  }

  private shutDown(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private deliver(event: UpnpEvent): void {
    setImmediate(() => {
      if (!this.ended) this.emit("event", event);
    });
  }

  private serve(): void {
    const { server } = this;
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.on("connection", (socket: net.Socket) => {
      const from = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (!this.opts.gateway.includes(from)) socket.destroy();
    });
    server.on("request", (req, res) => this.receive(req, res));
  }

  private receive(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "NOTIFY") {
      req.resume();
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_NOTIFY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      const reply = (status: number): void => void res.writeHead(status, { "Content-Length": "0" }).end();
      const nt = req.headers["nt"];
      const nts = req.headers["nts"];
      const sid = String(req.headers["sid"] ?? "").trim();
      const seq = String(req.headers["seq"] ?? "").trim();
      if (size > MAX_NOTIFY_BYTES) return reply(413);
      if (nt === undefined || nts === undefined || !/^\d+$/.test(seq)) return reply(400);
      if (nt !== "upnp:event" || nts !== "upnp:propchange" || !sid) return reply(412);
      const properties = parseProperties(Buffer.concat(chunks).toString("utf8"));
      if (!properties) return reply(400);
      const event = { seq: Number(seq), properties };
      if (!this.sidValue) {
        if (this.early.length >= MAX_EARLY_EVENTS) return reply(412);
        this.early.push({ sid, event });
        return reply(200);
      }
      if (sid !== this.sidValue) return reply(412);
      reply(200);
      this.deliver(event);
    });
  }
}

/** The variables of an event's propertyset; null when the body is not XML. */
function parseProperties(body: string): Record<string, string> | null {
  if (XMLValidator.validate(body) !== true) return null;
  let doc: any;
  try {
    doc = xmlParser.parse(body);
  } catch {
    return null; // the parser refuses some names outright, e.g. __proto__
  }
  const properties: Record<string, string> = Object.create(null);
  const list = doc?.propertyset?.property;
  for (const property of Array.isArray(list) ? list : list === undefined ? [] : [list]) {
    if (property === null || typeof property !== "object") continue;
    for (const [name, value] of Object.entries(property)) {
      if (name.startsWith("@_") || name === "#text") continue;
      // A variable named twice in one property: the last one stands.
      const last = Array.isArray(value) ? value[value.length - 1] : value;
      properties[name] = decodeXmlEntities(fieldValue(last)).trim();
    }
  }
  return properties;
}
