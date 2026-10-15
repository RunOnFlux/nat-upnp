import dgram from "dgram";
import EventEmitter from "events";

/**
 * A UDP socket that never touches the network, so SSDP discovery can be driven
 * deterministically: the test decides when the bind succeeds and what arrives
 * on the wire.
 */
export class FakeSocket extends EventEmitter {
  readonly sent: { query: string; port: number; address: string }[] = [];
  boundTo: number | null = null;
  closed = false;
  /** When set, the bind fails instead of succeeding. */
  static failNextBind = false;

  /** Where a connected socket claims to be, for the route-query trick. */
  static localAddress = "192.168.1.50";
  /** When set, the connect fails instead of succeeding. */
  static failNextConnect = false;
  /** When set, the connect never calls back, so the timeout has to fire. */
  static hangNextConnect = false;

  connectedTo: { port: number; address: string } | null = null;

  /** The interface address the last setMulticastInterface call pinned, if any. */
  multicastInterface: string | null = null;

  bind(port?: number): void {
    this.boundTo = port ?? 0;
    if (FakeSocket.failNextBind) {
      FakeSocket.failNextBind = false;
      setImmediate(() => this.emit("error", new Error("EADDRINUSE")));
      return;
    }
    setImmediate(() => this.emit("listening"));
  }

  /**
   * A UDP connect sends nothing; it just asks the kernel which interface would
   * reach the far side, which is how the local address is discovered.
   */
  connect(port: number, address: string, callback?: () => void): void {
    this.connectedTo = { port, address };
    if (FakeSocket.hangNextConnect) {
      FakeSocket.hangNextConnect = false;
      return;
    }
    if (FakeSocket.failNextConnect) {
      FakeSocket.failNextConnect = false;
      setImmediate(() => this.emit("error", new Error("ENETUNREACH")));
      return;
    }
    setImmediate(() => callback?.());
  }

  address(): { address: string; family: string; port: number } {
    return { address: FakeSocket.localAddress, family: "IPv4", port: 54321 };
  }

  setMulticastInterface(address: string): void {
    if (this.closed) throw new Error("Not running");
    this.multicastInterface = address;
  }

  send(buf: Buffer, _off: number, _len: number, port: number, address: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push({ query: buf.toString("utf-8"), port, address });
  }

  close(): void {
    if (this.closed) throw new Error("Not running");
    this.closed = true;
  }

  /** Deliver a datagram as though it had arrived from the network. */
  deliver(text: string): void {
    this.emit("message", Buffer.from(text, "utf-8"));
  }
}

export function installFakeDgram(): { sockets: FakeSocket[]; restore: () => void } {
  const real = dgram.createSocket;
  const sockets: FakeSocket[] = [];
  (dgram as any).createSocket = (..._args: unknown[]) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return {
    sockets,
    restore: () => {
      (dgram as any).createSocket = real;
      FakeSocket.failNextBind = false;
      FakeSocket.failNextConnect = false;
      FakeSocket.hangNextConnect = false;
      FakeSocket.localAddress = "192.168.1.50";
    },
  };
}

/** A well-formed M-SEARCH response for the given search target. */
export function ssdpResponse(st: string, location = "http://192.0.2.1:5000/rootDesc.xml"): string {
  return [
    "HTTP/1.1 200 OK",
    "CACHE-CONTROL: max-age=120",
    `ST: ${st}`,
    "USN: uuid:00000001-0000-4000-8000-000000000001",
    `LOCATION: ${location}`,
    "SERVER: FreeBSD/13 UPnP/1.1 MiniUPnPd/2.3.9",
    "",
    "",
  ].join("\r\n");
}

/** Wait for pending setImmediate callbacks (bind, listening) to run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}
