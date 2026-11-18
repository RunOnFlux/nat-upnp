import { EventEmitter } from "events";
import http from "http";
import net from "net";

import { XMLValidator } from "fast-xml-parser";

import { GENA, SubscriptionError, decodeXmlEntities, fieldValue, xmlParser, type EventSubscription } from "./device";

/** One NOTIFY: its sequence number and the variables it carries. */
export interface UpnpEvent {
  /** The gateway's numbering: 0 on subscribing, then one up per event, wrapping from
   *  4294967295 to 1. A gap means an event was missed. */
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

/** How the listener answers a NOTIFY, as GENA requires. */
const NOTIFY_ANSWER = Object.freeze({
  OK: 200,
  /** No NT, NTS or decimal SEQ, or a body that is not a propertyset. */
  BAD_REQUEST: 400,
  NOT_NOTIFY: 405,
  /** A wrong NT or NTS, a SID that is not this subscription's, or one early NOTIFY too many. */
  PRECONDITION_FAILED: 412,
  TOO_LARGE: 413,
} as const);

const MAX_NOTIFY_BYTES = 64 * 1024;
/** NOTIFYs held while the SUBSCRIBE is unanswered, as its SID is not known yet. */
const MAX_EARLY_EVENTS = 16;
/** Bounds on a connection: only the gateway can open one, but it can stall like any peer. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Whatever the gateway grants, a renewal comes within a day and the subscription lapses
 *  within two without one being answered: "infinite" never lapses on its own, a gateway
 *  that reboots or vanishes must still be noticed, and a timer past 2^31-1 ms fires at once. */
const MAX_RENEW_DELAY_MS = 86_400_000;
const MAX_LAPSE_MS = 2 * 86_400_000;
/** Spacing of retries for a renewal that got no answer: an eighth of the lifetime, within these. */
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const MAX_CONNECTIONS = 16;

export interface Subscription {
  on(event: "event", listener: (event: UpnpEvent) => void): this;
  /** The subscription has ended without close(): a renewal was refused, it lapsed
   *  without one being answered, or the listener failed. No event follows. */
  on(event: "lost", listener: (reason: Error) => void): this;
  /** The subscription has ended, by close() or "lost"; emitted once, last. */
  on(event: "close", listener: () => void): this;
  once(event: "event", listener: (event: UpnpEvent) => void): this;
  once(event: "lost", listener: (reason: Error) => void): this;
  once(event: "close", listener: () => void): this;
}

/**
 * A subscription to the gateway's events, with the listener that receives them. Each grant
 * arms two timers: a renewal at half the lifetime, and a lapse at the whole of it. A
 * renewal the gateway refuses ends the subscription ("lost"); one it does not answer is
 * retried until the lapse fires, which ends it too. No clock is read, so a step in the
 * wall clock changes nothing. It ends on close() or "lost", and either way UNSUBSCRIBEs
 * unless the gateway has answered that it no longer holds the SID.
 *
 * Events are emitted on a later tick than the NOTIFY that carried them, so the gateway is
 * answered whatever a listener does, and in the order their NOTIFYs arrive: they are not
 * held back to restore the gateway's numbering, since one lost NOTIFY would then stall
 * every event after it. The NOTIFY the gateway sends on subscribing can arrive before the
 * SUBSCRIBE is answered; it is held until the SID is known, so the first event is never
 * lost.
 *
 * The listener answers the gateway as GENA requires: 400 for a NOTIFY without NT, NTS or
 * a decimal SEQ, or with a body that is not a propertyset; 412 for a wrong NT or NTS, or,
 * once the SID is known, a SID that is not this subscription's; 413 for a body over
 * 64 KiB. Until the SID is known a NOTIFY is answered 200 and held, at most 16 (412
 * beyond), and those with another SID are dropped. A connection from any other address
 * is closed unanswered.
 */
export class Subscription extends EventEmitter {
  private sidValue = "";
  private granted: number | null = null;
  private renewTimer: NodeJS.Timeout | undefined;
  private lapseTimer: NodeJS.Timeout | undefined;
  private retryMs = MIN_RETRY_MS;
  private lastRenewalError: Error | null = null;
  private early: Array<{ sid: string; event: UpnpEvent }> = [];
  private ended = false;

  private constructor(
    private readonly server: http.Server,
    private readonly requests: SubscriptionRequests,
    private readonly opts: SubscriptionOpts
  ) {
    super();
  }

  /**
   * Listen, then subscribe. Until this resolves it owns every failure — the listener's,
   * the SUBSCRIBE's, an abort — and rejects with it, after unsubscribing every SID it
   * learned (from the answer, or from events that arrived first: a SUBSCRIBE whose answer
   * was lost can still have subscribed) and closing the listener. "lost" and "close" come
   * only from a subscription it returned.
   */
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

    let failure: { reason: unknown } | null = null;
    const fail = (reason: unknown): void => {
      failure ??= { reason };
    };
    server.on("error", fail);
    let granted: EventSubscription | null = null;
    try {
      const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
      granted = await requests.subscribe(`http://${host}:${(server.address() as net.AddressInfo).port}/`, opts.timeout);
    } catch (err) {
      fail(err);
    }

    if (failure !== null) {
      const sids = new Set(sub.early.map((e) => e.sid));
      if (granted) sids.add(granted.sid);
      await Promise.all([...[...sids].map((sid) => requests.unsubscribe(sid).catch(() => {})), sub.shutDown()]);
      throw (failure as { reason: unknown }).reason;
    }

    server.off("error", fail);
    server.on("error", (err) => sub.lose(err));
    sub.sidValue = granted!.sid;
    sub.grant(granted!);
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

  /** Stop listening and UNSUBSCRIBE. Resolves whether or not the gateway answers. */
  async close(): Promise<void> {
    if (this.ended) return;
    setImmediate(() => this.emit("close"));
    await this.end(true);
  }

  private grant(granted: EventSubscription): void {
    this.granted = granted.timeout;
    this.lastRenewalError = null;
    this.clearTimers();
    // "infinite" is renewed at half the lifetime asked: a gateway that reboots forgets
    // the subscription, and only a refused renewal says so.
    const renewal = (granted.timeout ?? this.opts.timeout) * 1000;
    const lapse = granted.timeout === null ? MAX_LAPSE_MS : granted.timeout * 1000;
    const renewMs = clamp(renewal / 2, MIN_RETRY_MS, MAX_RENEW_DELAY_MS);
    this.retryMs = clamp(renewal / 8, MIN_RETRY_MS, MAX_RETRY_MS);
    this.renewTimer = setTimeout(() => void this.renew(), renewMs);
    this.lapseTimer = setTimeout(
      () => this.lose(this.lastRenewalError ?? new Error("the subscription lapsed with no renewal answered")),
      Math.max(Math.min(lapse, MAX_LAPSE_MS), renewMs + MIN_RETRY_MS)
    );
  }

  private async renew(): Promise<void> {
    try {
      const granted = await this.requests.renew(this.sidValue, this.opts.timeout);
      if (!this.ended) this.grant(granted);
    } catch (err) {
      if (this.ended) return;
      // A refusal ends the subscription; no answer leaves it standing until it lapses.
      if (err instanceof SubscriptionError) return this.lose(err);
      this.lastRenewalError = err instanceof Error ? err : new Error(String(err));
      this.renewTimer = setTimeout(() => void this.renew(), this.retryMs);
    }
  }

  private clearTimers(): void {
    clearTimeout(this.renewTimer);
    clearTimeout(this.lapseTimer);
    this.renewTimer = undefined;
    this.lapseTimer = undefined;
  }

  private lose(reason: Error): void {
    if (this.ended) return;
    void this.end(!(reason instanceof SubscriptionError && reason.status === GENA.SID_NOT_HELD));
    setImmediate(() => {
      this.emit("lost", reason);
      this.emit("close");
    });
  }

  /** No timer, no listener, and an UNSUBSCRIBE when the gateway may still hold the SID. */
  private async end(held: boolean): Promise<void> {
    this.ended = true;
    this.clearTimers();
    await Promise.all([held && this.requests.unsubscribe(this.sidValue).catch(() => {}), this.shutDown()]);
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
      const from = socket.remoteAddress ?? "";
      if (!this.opts.gateway.includes(from)) socket.destroy();
    });
    server.on("request", (req, res) => this.receive(req, res));
  }

  private receive(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Framed by Content-Length: an empty answer is otherwise sent chunked.
    const reply = (status: number): void => void res.writeHead(status, { "Content-Length": "0" }).end();
    if (req.method !== "NOTIFY") {
      req.resume();
      return reply(NOTIFY_ANSWER.NOT_NOTIFY);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_NOTIFY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      // Node trims each value, and joins a repeated header into one string.
      const { nt, nts, sid, seq } = req.headers as Record<string, string | undefined>;
      if (size > MAX_NOTIFY_BYTES) return reply(NOTIFY_ANSWER.TOO_LARGE);
      if (nt === undefined || nts === undefined || seq === undefined || !/^\d+$/.test(seq)) {
        return reply(NOTIFY_ANSWER.BAD_REQUEST);
      }
      if (nt !== GENA.NT || nts !== GENA.NTS || !sid) return reply(NOTIFY_ANSWER.PRECONDITION_FAILED);
      const properties = parseProperties(Buffer.concat(chunks).toString("utf8"));
      if (!properties) return reply(NOTIFY_ANSWER.BAD_REQUEST);
      const event = { seq: Number(seq), properties };
      if (!this.sidValue) {
        if (this.early.length >= MAX_EARLY_EVENTS) return reply(NOTIFY_ANSWER.PRECONDITION_FAILED);
        this.early.push({ sid, event });
        return reply(NOTIFY_ANSWER.OK);
      }
      if (sid !== this.sidValue) return reply(NOTIFY_ANSWER.PRECONDITION_FAILED);
      reply(NOTIFY_ANSWER.OK);
      this.deliver(event);
    });
  }
}

/** The variables of an event's propertyset; null when the body is not a propertyset. */
function parseProperties(body: string): Record<string, string> | null {
  if (XMLValidator.validate(body) !== true) return null;
  let set: any;
  try {
    set = xmlParser.parse(body).propertyset;
  } catch {
    return null; // the parser refuses some names outright, e.g. __proto__
  }
  if (set === undefined) return null;
  const properties: Record<string, string> = Object.create(null);
  // The parser gives "" for an empty element, a string for text, an object for one
  // property and an array for several.
  const list = set.property;
  for (const property of Array.isArray(list) ? list : [list]) {
    if (property === null || typeof property !== "object") continue;
    for (const [name, value] of Object.entries(property)) {
      if (name.startsWith("@_") || name === "#text") continue;
      // A variable named twice in one property: the last one stands.
      const last = Array.isArray(value) ? value[value.length - 1] : value;
      properties[name] = decodeXmlEntities(fieldValue(last));
    }
  }
  return properties;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
