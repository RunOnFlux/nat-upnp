import dgram, { Socket } from "dgram";
import EventEmitter from "events";

/**
 * SSDP discovery. Finds UPnP devices on the local network via multicast.
 * Uses a single UDP socket bound to 0.0.0.0 — the OS routes the multicast
 * query via the default gateway interface.
 */
export class Ssdp implements ISsdp {
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

    socket.on("listening", () => {
      this.bound = true;

      while (this.pendingSearches.length > 0) {
        const [device, emitter] = this.pendingSearches.shift()!;
        this.search(device, emitter);
      }
    });

    socket.once("error", () => {
      this.bound = false;
      if (this.socket === socket) {
        this.socket = null;
      }
      try { socket.close(); } catch { /* already closed */ }
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

    this.ssdpEmitter.on("device", ondevice);

    emitter.once("end", () => {
      this.ssdpEmitter.removeListener("device", ondevice);
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
type SearchEvent = <E extends Events>(
  ev: E,
  ...args: E extends "device" ? SearchArgs : []
) => boolean;
type Events = "device" | "end";
type Event<E extends Events> = E extends "device" ? SearchCallback : () => void;
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
