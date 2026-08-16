import dgram, { Socket } from "dgram";
import EventEmitter from "events";

import { resolveLocalAddress } from "./route";

/**
 * SSDP discovery. Finds UPnP devices on the local network via multicast.
 * One UDP socket, with the search pinned to the interface that carries this
 * host's internet traffic: a port mapping is only useful on the NAT the
 * internet reaches us through, and left to itself the kernel routes multicast
 * by its own table, which an unrelated 224.0.0.0/4 route can point elsewhere.
 */
export class Ssdp implements ISsdp {
  /**
   * Any public unicast address serves here: it is never sent a packet, only
   * used to ask the kernel which interface carries internet-bound traffic.
   */
  private static readonly INTERNET_ROUTE_PROBE = "8.8.8.8";

  private readonly sourcePort: number;
  private readonly multicast = "239.255.255.250";
  private readonly port = 1900;
  private readonly ssdpEmitter: SsdpEmitter = new EventEmitter();

  private socket: Socket | null = null;
  private bound = false;
  private closed = false;
  private readonly pendingSearches: [string, SsdpEmitter][] = [];

  constructor(options?: { sourcePort?: number }) {
    this.sourcePort = options?.sourcePort || 0;
  }

  private ensureSocket(): void {
    if (this.socket || this.closed) return;

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    // Store the socket now, before the bind resolves. Waiting for "listening"
    // meant a search arriving during the bind saw no socket and created a
    // second one; the later bind then overwrote this reference, so close()
    // released the idle socket and left the one carrying traffic open.
    // `bound` still gates sending, so callers never get an unbound socket.
    this.socket = socket;

    socket.on("message", (message) => {
      if (this.closed) return;
      this.parseResponse(message.toString("utf-8"));
    });

    socket.on("listening", async () => {
      try {
        const address = await resolveLocalAddress(Ssdp.INTERNET_ROUTE_PROBE);
        socket.setMulticastInterface(address);
      } catch {
        // No route to the internet, or the socket died while the route was
        // being resolved: leave the egress interface to the OS.
      }

      if (this.closed || this.socket !== socket) return;
      this.bound = true;

      while (this.pendingSearches.length > 0) {
        const [device, emitter] = this.pendingSearches.shift()!;
        this.search(device, emitter);
      }
    });

    // `on`, not `once`: a second error on a dead socket must land here too,
    // or it is an unhandled "error" event and the process dies.
    socket.on("error", (err) => {
      this.bound = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      try { socket.close(); } catch { /* already closed */ }

      // The real failure goes to every search waiting on this socket —
      // queued behind the bind or already subscribed. Silence here left
      // EADDRINUSE indistinguishable from "no router answered": the
      // caller's timer expired and reported a router-less network.
      const pending = this.pendingSearches.splice(0);
      for (const [, emitter] of pending) {
        emitError(emitter, err);
      }
      emitError(this.ssdpEmitter, err);
    });

    socket.bind(this.sourcePort);
  }

  private parseResponse(response: string) {
    if (!/^(HTTP|NOTIFY)/m.test(response)) return;

    const headers = parseMimeHeader(response);
    if (!headers.st) return;

    // Require a valid HTTP Location header — reject missing, empty, or non-http
    if (!headers.location || !headers.location.startsWith("http")) return;

    this.ssdpEmitter.emit("device", headers);
  }

  public search(device: string, emitter?: SsdpEmitter): SsdpEmitter {
    if (!emitter) {
      emitter = new EventEmitter() as SsdpEmitter;
    }

    this.ensureSocket();

    if (!this.bound) {
      this.pendingSearches.push([device, emitter]);
      return emitter;
    }

    const query = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: " + this.multicast + ":" + this.port + "\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 1\r\n" +
        "ST: " + device + "\r\n" +
        "\r\n"
    );

    this.socket!.send(query, 0, query.length, this.port, this.multicast);

    let ended = false;

    const ondevice: SearchCallback = (headers) => {
      if (ended || headers.st !== device) return;
      emitter!.emit("device", headers);
    };

    const onerror = (err: Error) => {
      if (ended) return;
      emitError(emitter!, err);
    };

    this.ssdpEmitter.on("device", ondevice);
    this.ssdpEmitter.on("error", onerror);

    emitter.once("end", () => {
      this.ssdpEmitter.removeListener("device", ondevice);
      this.ssdpEmitter.removeListener("error", onerror);
      ended = true;
    });

    return emitter;
  }

  public close() {
    if (this.closed) return;
    this.closed = true;
    this.bound = false;
    this.pendingSearches.length = 0;
    this.ssdpEmitter.removeAllListeners();

    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.close();
      } catch { /* already closed */ }
      this.socket = null;
    }
  }
}

/**
 * Deliver an error only where someone is listening: an unhandled "error"
 * event throws, so a caller who never subscribed keeps the timeout behaviour
 * instead of gaining a crash.
 */
function emitError(emitter: EventEmitter, err: Error): void {
  if (emitter.listenerCount("error") > 0) {
    emitter.emit("error", err);
  }
}

export function parseMimeHeader(headerStr: string) {
  const lines = headerStr.split(/\r?\n/);
  return lines.reduce<Record<string, string>>((headers, line) => {
    const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
    if (match) {
      headers[match[1].toLowerCase()] = match[2].trimEnd();
    }
    return headers;
  }, {});
}

export default Ssdp;

/*
 * ===================
 * ====== Types ======
 * ===================
 */

type SearchArgs = [Record<string, string>];
export type SearchCallback = (...args: SearchArgs) => void;
type EventArgs<E extends Events> = E extends "device"
  ? SearchArgs
  : E extends "error"
    ? [Error]
    : [];
type SearchEvent = <E extends Events>(ev: E, ...args: EventArgs<E>) => boolean;
type Events = "device" | "end" | "error";
type Event<E extends Events> = E extends "device"
  ? SearchCallback
  : E extends "error"
    ? (err: Error) => void
    : () => void;
type EventListener<T> = <E extends Events>(ev: E, callback: Event<E>) => T;

export interface SsdpEmitter extends EventEmitter {
  removeListener: EventListener<this>;
  addListener: EventListener<this>;
  once: EventListener<this>;
  on: EventListener<this>;
  emit: SearchEvent;
}

export interface ISsdp {
  search(device: string, emitter?: SsdpEmitter): SsdpEmitter;
  close(): void;
}
