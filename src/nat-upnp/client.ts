import { RawResponse } from "../index";
import Device, {
  GatewayDevice,
  ServiceCapabilities,
  UpnpError,
  decodeXmlEntities,
  fieldValue,
  xmlParser,
  ONLY_PERMANENT_LEASES,
} from "./device";
import Ssdp from "./ssdp";

/**
 * Holds the resolved gateway and provides lazy access to device info,
 * capabilities, and local address. All are fetched on first access and cached.
 */
export class UpnpInfo {
  readonly gateway: Device;
  private readonly localAddressOverride: string | null;

  private devicePromise: Promise<GatewayDevice | null> | null = null;
  private capabilitiesPromise: Promise<ServiceCapabilities | null> | null = null;

  constructor(gateway: Device, localAddressOverride?: string) {
    this.gateway = gateway;
    this.localAddressOverride = localAddressOverride || null;
  }

  /** Fetch and cache device info from rootDesc.xml. Returns null on failure. */
  getDevice(): Promise<GatewayDevice | null> {
    if (!this.devicePromise) {
      this.devicePromise = this.gateway.getDeviceInfo();
    }
    return this.devicePromise;
  }

  /** Fetch and cache service capabilities from SCPD. Returns null on failure. */
  getCapabilities(): Promise<ServiceCapabilities | null> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.gateway.getCapabilities();
    }
    return this.capabilitiesPromise;
  }

  /**
   * Get the local interface address used to reach the router.
   * If a localAddress was provided at construction (SSDP bypass mode), returns that.
   * Otherwise resolves via UDP connect (zero-packet kernel route query).
   */
  getLocalAddress(): Promise<string> {
    if (this.localAddressOverride) {
      return Promise.resolve(this.localAddressOverride);
    }
    return this.gateway.getLocalAddress();
  }

  /**
   * Convenience method: resolve all gateway info in one call.
   * Fetches device info, capabilities, and local address in parallel.
   * For callers who don't need lazy loading.
   */
  async getAll(): Promise<ResolvedGatewayInfo> {
    const [device, capabilities, localAddress] = await Promise.all([
      this.getDevice(),
      this.getCapabilities(),
      this.getLocalAddress(),
    ]);
    return { device, capabilities, localAddress };
  }
}

export interface ResolvedGatewayInfo {
  readonly device: GatewayDevice | null;
  readonly capabilities: ServiceCapabilities | null;
  readonly localAddress: string;
}

export class Client implements IClient {
  private readonly timeout: number;
  private readonly localAddress: string | null;
  private readonly cacheGateway: boolean;
  private cachedInfo: UpnpInfo | null = null;
  private pendingGateway: Promise<UpnpInfo> | null = null;
  private abortDiscovery: (() => void) | null = null;
  private closed = false;

  url: string | null;

  constructor(options: ClientOptions = {}) {
    if (options.url && !options.localAddress) {
      throw new Error("`localAddress` must be supplied if using `url`");
    }

    this.timeout = options.timeout || 1800;
    this.url = options.url || null;
    this.localAddress = options.localAddress || null;
    this.cacheGateway = options.cacheGateway || false;
  }

  public async createMapping(options: NewPortMappingOpts): Promise<RawResponse> {
    const info = await this.getGateway();
    const localAddress = await info.getLocalAddress();
    const ports = normalizeOptions(options);

    const args = (lease: number | string): (string | number)[][] => [
      ["NewRemoteHost", ports.remote.host ?? ""],
      ["NewExternalPort", String(ports.remote.port)],
      ["NewProtocol", validProtocol(options.protocol)],
      ["NewInternalPort", String(ports.internal.port)],
      ["NewInternalClient", ports.internal.host || localAddress],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", options.description || "node:nat:upnp"],
      ["NewLeaseDuration", lease],
    ];

    const requested = options.ttl ?? 60 * 30;

    try {
      return await info.gateway.run("AddPortMapping", args(requested));
    } catch (err) {
      // 725 is the router stating it keeps permanent mappings only. Asking
      // again without a lease gives the caller more than it requested rather
      // than nothing at all, so it is worth one retry. Every other refusal is
      // left to the caller: 718 means the port is taken and retrying
      // identically would fail identically, and 501 says only that something
      // went wrong, which is no basis for guessing.
      const refusedTheLease =
        err instanceof UpnpError && err.code === ONLY_PERMANENT_LEASES && Number(requested) !== 0;
      if (!refusedTheLease) throw err;
      return info.gateway.run("AddPortMapping", args(0));
    }
  }

  public async removeMapping(options: DeletePortMappingOpts): Promise<RawResponse> {
    const info = await this.getGateway();
    const ports = normalizeOptions(options, 0);

    return info.gateway.run("DeletePortMapping", [
      ["NewRemoteHost", ports.remote.host ?? ""],
      ["NewExternalPort", String(ports.remote.port)],
      ["NewProtocol", validProtocol(options.protocol)],
    ]);
  }

  public async getMappings(options: GetMappingOpts = {}): Promise<Mapping[]> {
    const info = await this.getGateway();
    const localAddress = await info.getLocalAddress();
    const results: Mapping[] = [];

    // Cap iteration to prevent infinite loops from malicious/broken routers
    const MAX_MAPPINGS = 10000;
    for (let i = 0; i < MAX_MAPPINGS; i++) {
      let data: RawResponse;
      try {
        data = await info.gateway.run("GetGenericPortMappingEntry", [
          ["NewPortMappingIndex", i],
        ]);
      } catch (err) {
        // Routers do not agree on how they signal "no entry at that index".
        // 713 and 714 are the standard answers; MikroTik and the TP-Link/Omada
        // models say 402 Invalid Args. Every end-of-table capture in the
        // corpus — empty table and end of walk alike — is one of these three.
        //
        // Anything else is the router failing, not the table ending, and a
        // partial listing must never pass for a complete one: a caller
        // checking whether its own mapping survived would conclude it is gone
        // and re-create it. Transport failures propagate the same way — a
        // dead socket is not an empty router.
        if (err instanceof UpnpError && (err.code === 713 || err.code === 714 || err.code === 402)) {
          break;
        }
        throw err;
      }

      const res = findResponseKey(data, "GetGenericPortMappingEntryResponse");
      if (!res) throw new Error("Incorrect response for GetGenericPortMappingEntry");

      const mapping = parseMapping(res, localAddress);

      // Only confirmed-local mappings pass the filter: null is not confirmation.
      if (options.local && !mapping.local) continue;
      if (options.description && !matchesDescription(mapping.description, options.description)) continue;

      results.push(mapping);
    }

    return results;
  }

  /**
   * Query a specific port mapping by external port and protocol.
   * O(1) lookup — single SOAP call, no iteration.
   * Returns null if the mapping does not exist.
   */
  public async getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null> {
    const info = await this.getGateway();
    const localAddress = await info.getLocalAddress();
    const protocol = validProtocol(options.protocol);
    const externalPort = validPort(options.public, "public port", 0);

    let data: RawResponse;
    try {
      data = await info.gateway.run("GetSpecificPortMappingEntry", [
        ["NewRemoteHost", options.remoteHost ?? ""],
        ["NewExternalPort", String(externalPort)],
        ["NewProtocol", protocol],
      ]);
    } catch (err) {
      if (err instanceof UpnpError && (err.code === 714 || err.code === 713)) return null;
      throw err;
    }

    const res = findResponseKey(data, "GetSpecificPortMappingEntryResponse");
    if (!res) throw new Error("Incorrect response for GetSpecificPortMappingEntry");

    const host = fieldValue(res.NewInternalClient);
    return {
      public: { host: options.remoteHost ?? "", port: externalPort },
      private: { host, port: parseInt(fieldValue(res.NewInternalPort), 10) || 0 },
      protocol: protocol.toLowerCase(),
      enabled: fieldValue(res.NewEnabled) === "1",
      description: fieldValue(res.NewPortMappingDescription),
      ttl: parseInt(fieldValue(res.NewLeaseDuration), 10) || 0,
      local: isLocal(host, localAddress),
    };
  }

  public async getStatusInfo(): Promise<StatusInfo> {
    const info = await this.getGateway();
    const data = await info.gateway.run("GetStatusInfo", []);

    const res = findResponseKey(data, "GetStatusInfoResponse");
    if (!res) throw new Error("Incorrect response for GetStatusInfo");

    return {
      connectionStatus: fieldValue(res.NewConnectionStatus),
      lastConnectionError: fieldValue(res.NewLastConnectionError),
      uptime: parseInt(fieldValue(res.NewUptime), 10) || 0,
    };
  }

  public async getPublicIp(): Promise<string> {
    const info = await this.getGateway();
    const data = await info.gateway.run("GetExternalIPAddress", []);

    const res = findResponseKey(data, "GetExternalIPAddressResponse");
    if (!res) throw new Error("Incorrect response for GetExternalIPAddress");

    return fieldValue(res.NewExternalIPAddress);
  }

  /**
   * Create a port mapping, allowing the router to assign a different external port
   * if the requested one is taken. IGD v2 action.
   */
  public async createAnyMapping(options: NewPortMappingOpts): Promise<{ reservedPort: number }> {
    const info = await this.getGateway();
    await this.requireCapability(info, "supportsAddAnyPortMapping", "AddAnyPortMapping");

    const localAddress = await info.getLocalAddress();
    const ports = normalizeOptions(options);

    const data = await info.gateway.run("AddAnyPortMapping", [
      ["NewRemoteHost", ports.remote.host ?? ""],
      ["NewExternalPort", String(ports.remote.port)],
      ["NewProtocol", validProtocol(options.protocol)],
      ["NewInternalPort", String(ports.internal.port)],
      ["NewInternalClient", ports.internal.host || localAddress],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", options.description || "node:nat:upnp"],
      ["NewLeaseDuration", options.ttl ?? 60 * 30],
    ]);

    const res = findResponseKey(data, "AddAnyPortMappingResponse");
    if (!res) throw new Error("Incorrect response for AddAnyPortMapping");

    return { reservedPort: parseInt(fieldValue(res.NewReservedPort), 10) || 0 };
  }

  public async removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse> {
    const info = await this.getGateway();
    await this.requireCapability(info, "supportsDeletePortMappingRange", "DeletePortMappingRange");

    return info.gateway.run("DeletePortMappingRange", [
      ["NewStartPort", String(validPort(options.startPort, "startPort", 0))],
      ["NewEndPort", String(validPort(options.endPort, "endPort", 0))],
      ["NewProtocol", validProtocol(options.protocol)],
      ["NewManage", options.manage ? "1" : "0"],
    ]);
  }

  public async getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]> {
    const info = await this.getGateway();
    await this.requireCapability(info, "supportsGetListOfPortMappings", "GetListOfPortMappings");

    const localAddress = await info.getLocalAddress();
    const protocol = validProtocol(options.protocol);

    const data = await info.gateway.run("GetListOfPortMappings", [
      ["NewStartPort", String(validPort(options.startPort, "startPort", 0))],
      ["NewEndPort", String(validPort(options.endPort, "endPort", 0))],
      ["NewProtocol", protocol],
      ["NewManage", options.manage ? "1" : "0"],
      ["NewNumberOfPorts", String(options.numberOfPorts ?? 1000)],
    ]);

    const res = findResponseKey(data, "GetListOfPortMappingsResponse");
    if (!res) throw new Error("Incorrect response for GetListOfPortMappings");

    const portListing = fieldValue(res.NewPortListing);
    if (!portListing) return [];

    // NewPortListing carries an XML document inside a string, so it arrives
    // escaped. The shared parser leaves entities alone for XXE protection, so
    // without decoding first the inner parse finds no elements and every router
    // looks like it has no mappings at all.
    const parsed = xmlParser.parse(decodeXmlEntities(portListing));
    const list = parsed?.PortMappingList?.PortMappingEntry;
    if (!list) return [];

    const entries = Array.isArray(list) ? list : [list];
    return entries.map((entry: any) => {
      const host = fieldValue(entry.NewInternalClient);
      return {
        public: {
          host: fieldValue(entry.NewRemoteHost),
          port: parseInt(fieldValue(entry.NewExternalPort), 10) || 0,
        },
        private: { host, port: parseInt(fieldValue(entry.NewInternalPort), 10) || 0 },
        // The entry carries its own protocol; the requested one is only a
        // fallback for a router that omits it. Taking it from the request
        // would relabel anything that came back not matching the filter.
        protocol: fieldValue(entry.NewProtocol)
          ? fieldValue(entry.NewProtocol).toLowerCase()
          : protocol.toLowerCase(),
        enabled: fieldValue(entry.NewEnabled) === "1",
        description: fieldValue(entry.NewDescription),
        ttl: parseInt(fieldValue(entry.NewLeaseTime), 10) || 0,
        local: isLocal(host, localAddress),
      };
    });
  }

  public async getGateway(): Promise<UpnpInfo> {
    if (this.closed) {
      throw new Error("Client is closed");
    }

    // Direct URL mode — bypass SSDP
    if (this.url) {
      if (!this.cachedInfo) {
        this.cachedInfo = new UpnpInfo(new Device(this.url), this.localAddress!);
      }
      return this.cachedInfo;
    }

    // Return cached gateway
    if (this.cachedInfo) return this.cachedInfo;

    // Return pending search to avoid duplicate SSDP queries from concurrent callers
    if (this.pendingGateway) return this.pendingGateway;

    this.pendingGateway = this.discoverGateway();
    return this.pendingGateway;
  }

  private discoverGateway(): Promise<UpnpInfo> {
    // Create a fresh SSDP instance per discovery. It's closed automatically
    // when discovery completes — no socket left open, no leaks.
    const ssdp = new Ssdp();
    let resolved = false;

    const p = ssdp.search(
      "urn:schemas-upnp-org:device:InternetGatewayDevice:1"
    );

    const promise = new Promise<UpnpInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        p.emit("end");
        if (this.cachedInfo) {
          resolve(this.cachedInfo);
          return;
        }
        if (!resolved) {
          resolved = true;
          reject(new Error("Connection timed out while searching for the gateway."));
        }
      }, this.timeout);

      p.on("device", (headers) => {
        if (resolved) return;
        resolved = true;
        p.emit("end");
        clearTimeout(timeout);

        try {
          const upnpInfo = new UpnpInfo(new Device(headers.location));
          if (this.cacheGateway) {
            this.cachedInfo = upnpInfo;
          }
          resolve(upnpInfo);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // A socket failure is answered immediately with the real error —
      // EADDRINUSE is fixable on this machine, "no router here" is not, and
      // waiting for the timer to expire erased that difference. A cached
      // gateway is still served, exactly as the timeout path does.
      p.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        p.emit("end");
        clearTimeout(timeout);

        if (this.cachedInfo) {
          resolve(this.cachedInfo);
          return;
        }
        reject(err);
      });

      // close() settles the discovery immediately; without this the socket
      // and the timer both survived the close and ran to the full timeout.
      this.abortDiscovery = () => {
        if (resolved) return;
        resolved = true;
        p.emit("end");
        clearTimeout(timeout);
        reject(new Error("Client is closed"));
      };
    });

    // Clean up SSDP socket after discovery (success or failure) — no leaks.
    // The chained promise must be the one returned: .finally() produces a new
    // promise that adopts the rejection, so discarding it leaves an orphan that
    // Node reports as an unhandled rejection and, by default, exits on — even
    // when the caller has correctly caught the error from `promise` itself.
    return promise.finally(() => {
      ssdp.close();
      this.pendingGateway = null;
      this.abortDiscovery = null;
    });
  }

  public close() {
    this.closed = true;
    this.abortDiscovery?.();
  }

  private async requireCapability(
    info: UpnpInfo,
    capability: keyof ServiceCapabilities,
    action: string
  ): Promise<void> {
    const capabilities = await info.getCapabilities();
    if (!capabilities) {
      throw new UpnpError(401, `Cannot verify ${action} support (SCPD unavailable)`, action);
    }
    if (!capabilities[capability]) {
      throw new UpnpError(401, `${action} not supported by this device`, action);
    }
  }
}

/*
 * =======================
 * ====== Utilities ======
 * =======================
 */

/**
 * A port must be a 16-bit integer before it goes anywhere near the wire. The
 * router cannot be trusted to refuse anything else — miniupnpd truncates an
 * oversized value to 16 bits, maps the wrong port and answers success — and
 * GetSpecificPortMappingEntry returns neither port nor protocol, so a bad
 * value can never be caught by reading the mapping back.
 *
 * Creating a mapping requires 1-65535: nothing can listen on port 0, and some
 * routers treat an external 0 as a wildcard. References to existing entries
 * allow 0 — the surveyed MikroTik holds a placeholder rule at external port 0,
 * and what the table can hold, a caller must be able to name.
 */
function validPort(value: unknown, what: string, lowest: 0 | 1 = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < lowest || value > 65535) {
    throw new Error(
      `${what} must be an integer between ${lowest} and 65535, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function validProtocol(value: string | undefined): string {
  const protocol = (value ?? "TCP").toUpperCase();
  if (protocol !== "TCP" && protocol !== "UDP") {
    throw new Error(`protocol must be TCP or UDP, got ${JSON.stringify(value)}`);
  }
  return protocol;
}

function normalizeOptions(options: StandardOpts, lowestPort: 0 | 1 = 1) {
  function toObject(addr: StandardOpts["public"]): { port?: number; host?: string } {
    if (typeof addr === "number") return { port: addr };
    if (typeof addr === "string") {
      const n = parseInt(addr, 10);
      return isFinite(n) ? { port: n } : {};
    }
    if (typeof addr === "object" && addr !== null) return addr;
    return {};
  }

  const remote = toObject(options.public);
  const internal = toObject(options.private);

  if (internal.port === undefined && remote.port !== undefined) {
    internal.port = remote.port;
  }

  remote.port = validPort(remote.port, "public port", lowestPort);
  internal.port = validPort(internal.port, "private port", lowestPort);

  return { remote, internal };
}

/**
 * Whether a mapping's internal client is this machine — a fact only when both
 * addresses are known. An empty value on either side is missing information,
 * not a match, so the answer is null rather than a guess in either direction.
 */
function isLocal(host: string, localAddress: string): boolean | null {
  if (!host || !localAddress) return null;
  return host === localAddress;
}

function parseMapping(res: any, localAddress: string): Mapping {
  const host = fieldValue(res.NewInternalClient);
  return {
    public: {
      host: fieldValue(res.NewRemoteHost),
      port: parseInt(fieldValue(res.NewExternalPort), 10) || 0,
    },
    private: { host, port: parseInt(fieldValue(res.NewInternalPort), 10) || 0 },
    protocol: fieldValue(res.NewProtocol) ? fieldValue(res.NewProtocol).toLowerCase() : "tcp",
    enabled: fieldValue(res.NewEnabled) === "1",
    description: fieldValue(res.NewPortMappingDescription),
    ttl: parseInt(fieldValue(res.NewLeaseDuration), 10) || 0,
    local: isLocal(host, localAddress),
  };
}

function findResponseKey(data: RawResponse, prefix: string): any | null {
  if (!data || typeof data !== "object") return null;
  const key = Object.keys(data).find((k) => k.startsWith(prefix));
  return key ? data[key] : null;
}

function matchesDescription(desc: string, filter: RegExp | string): boolean {
  if (typeof desc !== "string") return false;
  if (filter instanceof RegExp) return filter.test(desc);
  return desc.indexOf(filter) !== -1;
}

export default Client;

/*
 * ===================
 * ====== Types ======
 * ===================
 */

export interface Mapping {
  readonly public: { readonly host: string; readonly port: number };
  readonly private: { readonly host: string; readonly port: number };
  readonly protocol: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly ttl: number;
  /**
   * Whether the mapping points at this machine. true and false are facts;
   * null means it could not be determined, because this machine's address
   * did not resolve or the router omitted the entry's internal client.
   */
  readonly local: boolean | null;
}

export interface StatusInfo {
  readonly connectionStatus: string;
  readonly lastConnectionError: string;
  readonly uptime: number;
}

export interface StandardOpts {
  public?: number | { port?: number; host?: string };
  private?: number | { port?: number; host?: string };
  protocol?: string;
}

export interface NewPortMappingOpts extends StandardOpts {
  description?: string;
  ttl?: number;
}

export type DeletePortMappingOpts = StandardOpts;

export interface GetMappingOpts {
  local?: boolean;
  description?: RegExp | string;
}

export interface GetSpecificMappingOpts {
  public: number;
  protocol?: string;
  remoteHost?: string;
}

export interface DeleteMappingRangeOpts {
  startPort: number;
  endPort: number;
  protocol?: string;
  manage?: boolean;
}

export interface GetMappingRangeOpts {
  startPort: number;
  endPort: number;
  protocol?: string;
  manage?: boolean;
  numberOfPorts?: number;
}

export interface ClientOptions {
  timeout?: number;
  url?: string;
  localAddress?: string;
  cacheGateway?: boolean;
}

export interface IClient {
  url: string | null;
  createMapping(options: NewPortMappingOpts): Promise<RawResponse>;
  createAnyMapping(options: NewPortMappingOpts): Promise<{ reservedPort: number }>;
  removeMapping(options: DeletePortMappingOpts): Promise<RawResponse>;
  removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse>;
  getMappings(options?: GetMappingOpts): Promise<Mapping[]>;
  getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]>;
  getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null>;
  getStatusInfo(): Promise<StatusInfo>;
  getPublicIp(): Promise<string>;
  getGateway(): Promise<UpnpInfo>;
  close(): void;
}
