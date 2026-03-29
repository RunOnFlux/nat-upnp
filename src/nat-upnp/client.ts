import { RawResponse } from "../index";
import Device, { GatewayDevice, ServiceCapabilities, UpnpError, xmlParser } from "./device";
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
}

export class Client implements IClient {
  private readonly timeout: number;
  private readonly ssdp = new Ssdp();
  private readonly localAddress: string | null;
  private readonly cacheGateway: boolean;
  private cachedInfo: UpnpInfo | null = null;
  private pendingGateway: Promise<UpnpInfo> | null = null;

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

    return info.gateway.run("AddPortMapping", [
      ["NewRemoteHost", ports.remote.host ?? ""],
      ["NewExternalPort", String(ports.remote.port)],
      ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
      ["NewInternalPort", String(ports.internal.port)],
      ["NewInternalClient", ports.internal.host || localAddress],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", options.description || "node:nat:upnp"],
      ["NewLeaseDuration", options.ttl ?? 60 * 30],
    ]);
  }

  public async removeMapping(options: DeletePortMappingOpts): Promise<RawResponse> {
    const info = await this.getGateway();
    const ports = normalizeOptions(options);

    return info.gateway.run("DeletePortMapping", [
      ["NewRemoteHost", ports.remote.host ?? ""],
      ["NewExternalPort", String(ports.remote.port)],
      ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
    ]);
  }

  public async getMappings(options: GetMappingOpts = {}): Promise<Mapping[]> {
    const info = await this.getGateway();
    const localAddress = options.local ? await info.getLocalAddress() : "";
    const results: Mapping[] = [];

    const MAX_MAPPINGS = 10000;
    for (let i = 0; i < MAX_MAPPINGS; i++) {
      let data: RawResponse;
      try {
        data = await info.gateway.run("GetGenericPortMappingEntry", [
          ["NewPortMappingIndex", i],
        ]);
      } catch {
        break;
      }

      const res = findResponseKey(data, "GetGenericPortMappingEntryResponse");
      if (!res) break;

      const mapping = parseMapping(res, localAddress);

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
    const protocol = (options.protocol || "TCP").toUpperCase();

    let data: RawResponse;
    try {
      data = await info.gateway.run("GetSpecificPortMappingEntry", [
        ["NewRemoteHost", options.remoteHost ?? ""],
        ["NewExternalPort", String(options.public)],
        ["NewProtocol", protocol],
      ]);
    } catch (err) {
      if (err instanceof UpnpError && (err.code === 714 || err.code === 713)) return null;
      throw err;
    }

    const res = findResponseKey(data, "GetSpecificPortMappingEntryResponse");
    if (!res) throw new Error("Incorrect response for GetSpecificPortMappingEntry");

    const host = String(res.NewInternalClient ?? "");
    return {
      public: { host: options.remoteHost ?? "", port: Number(options.public) },
      private: { host, port: parseInt(res.NewInternalPort, 10) || 0 },
      protocol: protocol.toLowerCase(),
      enabled: res.NewEnabled === 1 || res.NewEnabled === "1",
      description: String(res.NewPortMappingDescription ?? ""),
      ttl: parseInt(res.NewLeaseDuration, 10) || 0,
      local: host === localAddress,
    };
  }

  public async getStatusInfo(): Promise<StatusInfo> {
    const info = await this.getGateway();
    const data = await info.gateway.run("GetStatusInfo", []);

    const res = findResponseKey(data, "GetStatusInfoResponse");
    if (!res) throw new Error("Incorrect response for GetStatusInfo");

    return {
      connectionStatus: String(res.NewConnectionStatus ?? ""),
      lastConnectionError: String(res.NewLastConnectionError ?? ""),
      uptime: parseInt(res.NewUptime, 10) || 0,
    };
  }

  public async getPublicIp(): Promise<string> {
    const info = await this.getGateway();
    const data = await info.gateway.run("GetExternalIPAddress", []);

    const res = findResponseKey(data, "GetExternalIPAddressResponse");
    if (!res) throw new Error("Incorrect response for GetExternalIPAddress");

    return String(res.NewExternalIPAddress ?? "");
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
      ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
      ["NewInternalPort", String(ports.internal.port)],
      ["NewInternalClient", ports.internal.host || localAddress],
      ["NewEnabled", 1],
      ["NewPortMappingDescription", options.description || "node:nat:upnp"],
      ["NewLeaseDuration", options.ttl ?? 60 * 30],
    ]);

    const res = findResponseKey(data, "AddAnyPortMappingResponse");
    if (!res) throw new Error("Incorrect response for AddAnyPortMapping");

    return { reservedPort: parseInt(res.NewReservedPort, 10) || 0 };
  }

  public async removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse> {
    const info = await this.getGateway();
    await this.requireCapability(info, "supportsDeletePortMappingRange", "DeletePortMappingRange");

    return info.gateway.run("DeletePortMappingRange", [
      ["NewStartPort", String(options.startPort)],
      ["NewEndPort", String(options.endPort)],
      ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
      ["NewManage", options.manage ? "1" : "0"],
    ]);
  }

  public async getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]> {
    const info = await this.getGateway();
    await this.requireCapability(info, "supportsGetListOfPortMappings", "GetListOfPortMappings");

    const localAddress = await info.getLocalAddress();
    const protocol = (options.protocol || "TCP").toUpperCase();

    const data = await info.gateway.run("GetListOfPortMappings", [
      ["NewStartPort", String(options.startPort)],
      ["NewEndPort", String(options.endPort)],
      ["NewProtocol", protocol],
      ["NewManage", options.manage ? "1" : "0"],
      ["NewNumberOfPorts", String(options.numberOfPorts ?? 1000)],
    ]);

    const res = findResponseKey(data, "GetListOfPortMappingsResponse");
    if (!res) throw new Error("Incorrect response for GetListOfPortMappings");

    const portListing = res.NewPortListing;
    if (!portListing) return [];

    const parsed = xmlParser.parse(String(portListing));
    const list = parsed?.PortMappingList?.PortMappingEntry;
    if (!list) return [];

    const entries = Array.isArray(list) ? list : [list];
    return entries.map((entry: any) => {
      const host = String(entry.NewInternalClient ?? "");
      return {
        public: {
          host: String(entry.NewRemoteHost ?? ""),
          port: parseInt(entry.NewExternalPort, 10) || 0,
        },
        private: { host, port: parseInt(entry.NewInternalPort, 10) || 0 },
        protocol: protocol.toLowerCase(),
        enabled: entry.NewEnabled === "1" || entry.NewEnabled === 1,
        description: String(entry.NewDescription ?? ""),
        ttl: parseInt(entry.NewLeaseTime, 10) || 0,
        local: host === localAddress,
      };
    });
  }

  public async getGateway(): Promise<UpnpInfo> {
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
    let resolved = false;
    const p = this.ssdp.search(
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

        const upnpInfo = new UpnpInfo(new Device(headers.location));
        if (this.cacheGateway) {
          this.cachedInfo = upnpInfo;
        }
        resolve(upnpInfo);
      });
    });

    // Clear pending on completion (success or failure)
    promise.finally(() => {
      this.pendingGateway = null;
    });

    return promise;
  }

  public close() {
    this.ssdp.close();
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

function normalizeOptions(options: StandardOpts) {
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

  return { remote, internal };
}

function parseMapping(res: any, localAddress: string): Mapping {
  const host = String(res.NewInternalClient ?? "");
  return {
    public: {
      host: typeof res.NewRemoteHost === "string" ? res.NewRemoteHost : "",
      port: parseInt(res.NewExternalPort, 10) || 0,
    },
    private: { host, port: parseInt(res.NewInternalPort, 10) || 0 },
    protocol: res.NewProtocol ? String(res.NewProtocol).toLowerCase() : "tcp",
    enabled: res.NewEnabled === "1" || res.NewEnabled === 1,
    description: String(res.NewPortMappingDescription ?? ""),
    ttl: parseInt(res.NewLeaseDuration, 10) || 0,
    local: host === localAddress,
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
  readonly local: boolean;
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
