import net from "net";
import { RawResponse } from "../index";
import Device, {
  GatewayDevice,
  ServiceCapabilities,
  UpnpError,
  CapabilityUnavailableError,
  UnsupportedActionError,
  decodeXmlEntities,
  fieldValue,
  xmlParser,
  ONLY_PERMANENT_LEASES,
  RequestOpts,
  untilAborted,
} from "./device";
import Ssdp from "./ssdp";

/**
 * Holds the resolved gateway and provides lazy access to device info,
 * capabilities, and local address. Device info and capabilities are fetched on
 * first access and cached; the local address is asked for on every call.
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

  /**
   * Fetch and cache device info from rootDesc.xml. Returns null on failure —
   * and a failure is never cached: the Device layer retries after one, and
   * pinning its null answer here would hold "unavailable" for the life of
   * this UpnpInfo, which in url mode and cacheGateway mode is the life of
   * the client.
   */
  getDevice(): Promise<GatewayDevice | null> {
    if (!this.devicePromise) {
      this.devicePromise = this.gateway.getDeviceInfo().then((device) => {
        if (device === null) {
          this.devicePromise = null;
        }
        return device;
      });
    }
    return this.devicePromise;
  }

  /** Fetch and cache service capabilities from SCPD. Returns null on failure;
   * a failure is never cached, for the same reason as getDevice. */
  getCapabilities(): Promise<ServiceCapabilities | null> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.gateway.getCapabilities().then((capabilities) => {
        if (capabilities === null) {
          this.capabilitiesPromise = null;
        }
        return capabilities;
      });
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

    this.timeout = options.timeout || 5000;
    this.url = options.url || null;
    this.localAddress = options.localAddress || null;
    this.cacheGateway = options.cacheGateway || false;
  }

  /**
   * Resolves with the router's answer to AddPortMapping. On a request sent
   * again after the gateway moved (see `cacheGateway`), a 718 is the first
   * request having landed: when the router holds this exact mapping - this
   * internal client, internal port and description - the call resolves with
   * the router's answer to the lookup that found it.
   */
  public async createMapping(options: NewPortMappingOpts): Promise<RawResponse> {
    const { signal } = options;
    const ports = normalizeOptions(options);
    const protocol = validProtocol(options.protocol);
    const description = options.description || "node:nat:upnp";
    const requested = validTtl(options.ttl ?? 60 * 30, "ttl");

    return this.onGateway(signal, async (info, retry) => {
      const localAddress = await untilAborted(info.getLocalAddress(), signal);
      const internalClient = internalClientFor(ports.internal.host, localAddress);

      const args = (lease: number | string): (string | number)[][] => [
        ["NewRemoteHost", ports.remote.host ?? ""],
        ["NewExternalPort", String(ports.remote.port)],
        ["NewProtocol", protocol],
        ["NewInternalPort", String(ports.internal.port)],
        ["NewInternalClient", internalClient],
        ["NewEnabled", 1],
        ["NewPortMappingDescription", description],
        ["NewLeaseDuration", lease],
      ];

      try {
        try {
          return await info.gateway.run("AddPortMapping", args(requested), { signal });
        } catch (err) {
          // 725 is the router stating it keeps permanent mappings only. Asking
          // again without a lease gives the caller more than it requested rather
          // than nothing at all, so it is worth one retry. Every other refusal is
          // left to the caller: 718 means the port is taken and retrying
          // identically would fail identically, and 501 says only that something
          // went wrong, which is no basis for guessing.
          const refusedTheLease =
            err instanceof UpnpError && err.code === ONLY_PERMANENT_LEASES && requested !== 0;
          if (!refusedTheLease) throw err;
          return await info.gateway.run("AddPortMapping", args(0), { signal });
        }
      } catch (err) {
        if (!retry || !(err instanceof UpnpError) || err.code !== CONFLICT_IN_MAPPING_ENTRY) throw err;
        const held = await this.lookUp(info, ports.remote.host ?? "", ports.remote.port, protocol, signal);
        const isThisMapping =
          held !== null &&
          held.mapping.private.host === internalClient &&
          held.mapping.private.port === ports.internal.port &&
          canonicalDescription(held.mapping.description) === canonicalDescription(description);
        if (!isThisMapping) throw err;
        return held.raw;
      }
    });
  }

  /**
   * Resolves with the router's answer to DeletePortMapping. On a request sent
   * again after the gateway moved (see `cacheGateway`), a 714 is the first
   * request having landed, and the call resolves with an empty answer.
   */
  public async removeMapping(options: DeletePortMappingOpts): Promise<RawResponse> {
    const { signal } = options;
    const ports = normalizeOptions(options, 0);
    const protocol = validProtocol(options.protocol);

    return this.onGateway(signal, async (info, retry) => {
      try {
        return await info.gateway.run(
          "DeletePortMapping",
          [
            ["NewRemoteHost", ports.remote.host ?? ""],
            ["NewExternalPort", String(ports.remote.port)],
            ["NewProtocol", protocol],
          ],
          { signal }
        );
      } catch (err) {
        if (retry && err instanceof UpnpError && err.code === NO_SUCH_ENTRY) return {};
        throw err;
      }
    });
  }

  public async getMappings(options: GetMappingOpts = {}): Promise<Mapping[]> {
    const { signal } = options;
    return this.onGateway(signal, (info) => this.walkMappings(info, options));
  }

  /**
   * The router's mapping at `index` of its table, read with one
   * GetGenericPortMappingEntry, or null where the table ends. A caller reads
   * the table an entry at a time from 0 until null, sending other requests
   * between entries as it likes. The table can change between two reads: an
   * entry added or removed meanwhile shifts the ones after it, so a read can
   * skip an entry or give one again.
   *
   * The table ends as getMappings' walk ends: at an index the router answers
   * with any fault but one about the action itself, which throws, as does no
   * answer.
   */
  public async getMappingAt(options: GetMappingAtOpts): Promise<Mapping | null> {
    const { signal } = options;
    const index = validIndex(options.index);
    return this.onGateway(signal, async (info) => {
      const localAddress = await untilAborted(info.getLocalAddress(), signal);
      return this.entryAt(info, index, localAddress, signal);
    });
  }

  private async walkMappings(info: UpnpInfo, options: GetMappingOpts): Promise<Mapping[]> {
    const { signal } = options;
    const localAddress = await untilAborted(info.getLocalAddress(), signal);
    const results: Mapping[] = [];

    // Cap the walk against routers that answer every index and never signal
    // end-of-table. Reaching the cap is the router malfunctioning, not the
    // listing completing — the spec's ui2 table-size ceiling is 65535 and no
    // surveyed firmware holds more than a few hundred — so it is an error
    // like any other mid-walk failure, never a listing passed off as
    // complete.
    const MAX_MAPPINGS = 10000;
    for (let i = 0; ; i++) {
      if (i >= MAX_MAPPINGS) {
        throw new Error(
          `Mapping table walk passed ${MAX_MAPPINGS} entries without an end-of-table answer`
        );
      }
      const mapping = await this.entryAt(info, i, localAddress, signal);
      if (!mapping) break;

      // Only confirmed-local mappings pass the filter: null is not confirmation.
      if (options.local && !mapping.local) continue;
      if (options.description && !matchesDescription(mapping.description, options.description)) continue;

      results.push(mapping);
    }

    return results;
  }

  /** One GetGenericPortMappingEntry: the entry at `index`, or null where the table ends. */
  private async entryAt(
    info: UpnpInfo,
    index: number,
    localAddress: string,
    signal?: AbortSignal
  ): Promise<Mapping | null> {
    let data: RawResponse;
    try {
      data = await info.gateway.run(
        "GetGenericPortMappingEntry",
        [["NewPortMappingIndex", index]],
        { signal }
      );
    } catch (err) {
      // A fault is the router answering about that index, and the first
      // index it has no entry for ends the table, whatever the code: 713
      // and 714 are the standard's, MikroTik and TP-Link/Omada say 402,
      // Mercusys 501. Only a fault about the action itself - 401 Invalid
      // Action, 602 Not Implemented, 606 Not Authorized - says the router
      // will not list its table at all, and is thrown.
      //
      // No answer, or one that is not a SOAP reply, is the router failing,
      // not the table ending, and is thrown: a dead socket is not an empty
      // router.
      if (err instanceof UpnpError && !ACTION_REFUSALS.has(err.code)) return null;
      throw err;
    }

    const res = findResponseKey(data, "GetGenericPortMappingEntryResponse");
    if (!res) throw new Error("Incorrect response for GetGenericPortMappingEntry");

    return parseMapping(res, localAddress);
  }

  /**
   * Query a specific port mapping by external port and protocol.
   * O(1) lookup — single SOAP call, no iteration.
   * Returns null if the mapping does not exist.
   */
  public async getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null> {
    const { signal } = options;
    const protocol = validProtocol(options.protocol);
    const externalPort = validPort(options.public, "public port", 0);

    return this.onGateway(signal, async (info) => {
      const held = await this.lookUp(info, options.remoteHost ?? "", externalPort, protocol, signal);
      return held && held.mapping;
    });
  }

  /**
   * One GetSpecificPortMappingEntry: the mapping and the router's answer it was
   * read from, or null when the router holds no such entry.
   */
  private async lookUp(
    info: UpnpInfo,
    remoteHost: string,
    externalPort: number,
    protocol: string,
    signal?: AbortSignal
  ): Promise<{ mapping: Mapping; raw: RawResponse } | null> {
    const localAddress = await untilAborted(info.getLocalAddress(), signal);
    let data: RawResponse;
    try {
      data = await info.gateway.run(
        "GetSpecificPortMappingEntry",
        [
          ["NewRemoteHost", remoteHost],
          ["NewExternalPort", String(externalPort)],
          ["NewProtocol", protocol],
        ],
        { signal }
      );
    } catch (err) {
      if (err instanceof UpnpError && (err.code === NO_SUCH_ENTRY || err.code === 713)) return null;
      throw err;
    }

    const res = findResponseKey(data, "GetSpecificPortMappingEntryResponse");
    if (!res) throw new Error("Incorrect response for GetSpecificPortMappingEntry");

    const host = fieldValue(res.NewInternalClient);
    return {
      mapping: {
        public: { host: remoteHost, port: externalPort },
        private: { host, port: parseInt(fieldValue(res.NewInternalPort), 10) || 0 },
        protocol: protocol.toLowerCase(),
        enabled: fieldValue(res.NewEnabled) === "1",
        description: decodeXmlEntities(fieldValue(res.NewPortMappingDescription)),
        ttl: parseInt(fieldValue(res.NewLeaseDuration), 10) || 0,
        local: isLocal(host, localAddress),
      },
      raw: data,
    };
  }

  public async getStatusInfo(options: RequestOpts = {}): Promise<StatusInfo> {
    const { signal } = options;
    return this.onGateway(signal, async (info) => {
      const data = await info.gateway.run("GetStatusInfo", [], { signal });

      const res = findResponseKey(data, "GetStatusInfoResponse");
      if (!res) throw new Error("Incorrect response for GetStatusInfo");

      return {
        connectionStatus: fieldValue(res.NewConnectionStatus),
        lastConnectionError: fieldValue(res.NewLastConnectionError),
        uptime: parseInt(fieldValue(res.NewUptime), 10) || 0,
      };
    });
  }

  public async getPublicIp(options: RequestOpts = {}): Promise<string> {
    const { signal } = options;
    return this.onGateway(signal, async (info) => {
      const data = await info.gateway.run("GetExternalIPAddress", [], { signal });

      const res = findResponseKey(data, "GetExternalIPAddressResponse");
      if (!res) throw new Error("Incorrect response for GetExternalIPAddress");

      return fieldValue(res.NewExternalIPAddress);
    });
  }

  /**
   * Create a port mapping, allowing the router to assign a different external port
   * if the requested one is taken. IGD v2 action. Never sent twice: the router
   * picks the port, so a second request could hold a second one.
   */
  public async createAnyMapping(options: NewPortMappingOpts): Promise<{ reservedPort: number }> {
    const { signal } = options;
    const ports = normalizeOptions(options);
    const protocol = validProtocol(options.protocol);
    const ttl = validTtl(options.ttl ?? 60 * 30, "ttl");

    return this.onGateway(
      signal,
      async (info) => {
        await this.requireCapability(info, "supportsAddAnyPortMapping", "AddAnyPortMapping", signal);

        const localAddress = await untilAborted(info.getLocalAddress(), signal);

        const data = await info.gateway.run(
          "AddAnyPortMapping",
          [
            ["NewRemoteHost", ports.remote.host ?? ""],
            ["NewExternalPort", String(ports.remote.port)],
            ["NewProtocol", protocol],
            ["NewInternalPort", String(ports.internal.port)],
            ["NewInternalClient", internalClientFor(ports.internal.host, localAddress)],
            ["NewEnabled", 1],
            ["NewPortMappingDescription", options.description || "node:nat:upnp"],
            ["NewLeaseDuration", ttl],
          ],
          { signal }
        );

        const res = findResponseKey(data, "AddAnyPortMappingResponse");
        if (!res) throw new Error("Incorrect response for AddAnyPortMapping");

        return { reservedPort: parseInt(fieldValue(res.NewReservedPort), 10) || 0 };
      },
      false
    );
  }

  /**
   * Resolves with the router's answer to DeletePortMappingRange. On a request
   * sent again after the gateway moved (see `cacheGateway`), a 730 or 714 is
   * the first request having landed, and the call resolves with an empty
   * answer.
   */
  public async removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse> {
    const { signal } = options;
    const startPort = validPort(options.startPort, "startPort", 0);
    const endPort = validPort(options.endPort, "endPort", 0);
    const protocol = validProtocol(options.protocol);

    return this.onGateway(signal, async (info, retry) => {
      await this.requireCapability(
        info,
        "supportsDeletePortMappingRange",
        "DeletePortMappingRange",
        signal
      );

      try {
        return await info.gateway.run(
          "DeletePortMappingRange",
          [
            ["NewStartPort", String(startPort)],
            ["NewEndPort", String(endPort)],
            ["NewProtocol", protocol],
            ["NewManage", options.manage ? "1" : "0"],
          ],
          { signal }
        );
      } catch (err) {
        const nothingLeft =
          err instanceof UpnpError && (err.code === PORT_MAPPING_NOT_FOUND || err.code === NO_SUCH_ENTRY);
        if (retry && nothingLeft) return {};
        throw err;
      }
    });
  }

  public async getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]> {
    const { signal } = options;
    const startPort = validPort(options.startPort, "startPort", 0);
    const endPort = validPort(options.endPort, "endPort", 0);
    const protocol = validProtocol(options.protocol);
    const numberOfPorts = validPort(options.numberOfPorts ?? 1000, "numberOfPorts", 0);

    return this.onGateway(signal, (info) =>
      this.listRange(info, { startPort, endPort, protocol, numberOfPorts, manage: !!options.manage }, signal)
    );
  }

  private async listRange(
    info: UpnpInfo,
    range: { startPort: number; endPort: number; protocol: string; numberOfPorts: number; manage: boolean },
    signal?: AbortSignal
  ): Promise<Mapping[]> {
    const { protocol } = range;
    await this.requireCapability(
      info,
      "supportsGetListOfPortMappings",
      "GetListOfPortMappings",
      signal
    );

    const localAddress = await untilAborted(info.getLocalAddress(), signal);

    const data = await info.gateway.run(
      "GetListOfPortMappings",
      [
        ["NewStartPort", String(range.startPort)],
        ["NewEndPort", String(range.endPort)],
        ["NewProtocol", protocol],
        ["NewManage", range.manage ? "1" : "0"],
        ["NewNumberOfPorts", String(range.numberOfPorts)],
      ],
      { signal }
    );

    const res = findResponseKey(data, "GetListOfPortMappingsResponse");
    if (!res) throw new Error("Incorrect response for GetListOfPortMappings");

    // NewPortListing embeds an XML document in a string, and routers wrap it
    // two ways: CDATA (Ubiquiti, OpenWRT, Debian) delivers the document
    // as-is, while the escaped dialect delivers it with every '<' entity-
    // escaped. Only the escaped form gets the wrapper decode — decoding a
    // real document turns escaped text in its fields into live markup and
    // truncates the parse at the first '<' in anyone's description. A raw
    // '<' in the payload means it is already a document. A router could also
    // inline the listing as actual markup, in which case the parser has
    // already built the document. Any other non-empty shape is an answer
    // this code cannot read: an error, never an empty table.
    const rawListing = res.NewPortListing;
    let parsed: any;
    if (rawListing !== null && typeof rawListing === "object" && "PortMappingList" in rawListing) {
      parsed = rawListing;
    } else {
      const portListing = fieldValue(rawListing);
      if (!portListing) {
        const holdsContent =
          rawListing !== null &&
          typeof rawListing === "object" &&
          Object.keys(rawListing).some((key) => !key.startsWith("@_") && key !== "#text");
        if (holdsContent) {
          throw new Error("Unrecognized NewPortListing shape in GetListOfPortMappings response");
        }
        return [];
      }
      const document = portListing.includes("<")
        ? portListing
        : decodeXmlEntities(portListing);
      parsed = xmlParser.parse(document);
    }
    const list = parsed?.PortMappingList?.PortMappingEntry;
    if (!list) return [];

    const entries = Array.isArray(list) ? list : [list];
    return entries.map((entry: any) => {
      const host = fieldValue(entry.NewInternalClient);
      const entryProtocol = fieldValue(entry.NewProtocol);
      return {
        public: {
          host: fieldValue(entry.NewRemoteHost),
          port: parseInt(fieldValue(entry.NewExternalPort), 10) || 0,
        },
        private: { host, port: parseInt(fieldValue(entry.NewInternalPort), 10) || 0 },
        // The entry carries its own protocol; the requested one is only a
        // fallback for a router that omits it. Taking it from the request
        // would relabel anything that came back not matching the filter.
        protocol: entryProtocol ? entryProtocol.toLowerCase() : protocol.toLowerCase(),
        enabled: fieldValue(entry.NewEnabled) === "1",
        // The free-text field decodes after the parse, like the other two
        // read paths — the wrapper decode no longer reaches into fields.
        description: decodeXmlEntities(fieldValue(entry.NewDescription)),
        ttl: parseInt(fieldValue(entry.NewLeaseTime), 10) || 0,
        local: isLocal(host, localAddress),
      };
    });
  }

  /**
   * The gateway, found over SSDP unless a URL was given. Aborting `signal`
   * ends only this caller's wait: a discovery other callers share runs on.
   */
  public async getGateway(options: RequestOpts = {}): Promise<UpnpInfo> {
    if (this.closed) {
      throw new Error("Client is closed");
    }
    const { signal } = options;
    signal?.throwIfAborted();

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
    if (!this.pendingGateway) this.pendingGateway = this.discoverGateway();
    return untilAborted(this.pendingGateway, signal);
  }

  /**
   * Runs `request` against the gateway.
   *
   * Under `cacheGateway`, a request that fails with anything but a UPnP fault
   * - no connection, no answer in time, an answer that is not a SOAP reply -
   * is taken as the gateway possibly having moved: a router whose UPnP service
   * restarts answers on a new port. The cached gateway is dropped and the
   * router found again. If it now answers at a different location, `request` runs there
   * once more with `retry` set; at the same location the original failure
   * stands. A UPnP fault is the router answering, an abort is the caller's,
   * and an action the router says it lacks stays lacking, so none of these
   * look again.
   *
   * `retryable: false` drops the cached gateway but never sends the request a
   * second time.
   */
  private async onGateway<T>(
    signal: AbortSignal | undefined,
    request: (info: UpnpInfo, retry: boolean) => Promise<T>,
    retryable = true
  ): Promise<T> {
    const info = await this.getGateway({ signal });
    try {
      return await request(info, false);
    } catch (err) {
      const unanswered =
        this.cacheGateway &&
        !this.url &&
        !signal?.aborted &&
        !(err instanceof UpnpError) &&
        !(err instanceof UnsupportedActionError);
      if (!unanswered) throw err;
      if (this.cachedInfo === info) this.cachedInfo = null;
      if (!retryable) throw err;

      let found: UpnpInfo;
      try {
        found = await this.getGateway({ signal });
      } catch (discoveryErr) {
        if (signal?.aborted) throw discoveryErr;
        throw err;
      }
      if (found.gateway.description === info.gateway.description) throw err;
      return request(found, true);
    }
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
        if (!resolved) {
          resolved = true;
          reject(new Error("Connection timed out while searching for the gateway."));
        }
      }, this.timeout);

      p.on("device", (headers) => {
        if (resolved) return;
        // Mappings are IPv4 and the node's address is read from its route to
        // the router, so only an IPv4 location will do. Some routers answer
        // an IPv4 search twice, with an IPv6 location first; the IPv4 answer
        // that follows is the one taken.
        if (!isIPv4Location(headers.location)) return;
        resolved = true;
        p.emit("end");
        clearTimeout(timeout);

        try {
          const upnpInfo = new UpnpInfo(
            new Device(headers.location, { ssdpServer: headers.server }),
            this.localAddress ?? undefined
          );
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
      // waiting for the timer to expire erased that difference.
      p.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        p.emit("end");
        clearTimeout(timeout);
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
    action: string,
    signal?: AbortSignal
  ): Promise<void> {
    const capabilities = await untilAborted(info.getCapabilities(), signal);
    if (!capabilities) {
      throw new CapabilityUnavailableError(action);
    }
    if (!capabilities[capability]) {
      throw new UnsupportedActionError(action);
    }
  }
}

/*
 * =======================
 * ====== Utilities ======
 * =======================
 */

const NO_SUCH_ENTRY = 714;
const CONFLICT_IN_MAPPING_ENTRY = 718;
const PORT_MAPPING_NOT_FOUND = 730;
/** Faults about an action itself rather than its arguments: Invalid Action, Not Implemented, Not Authorized. */
const ACTION_REFUSALS = new Set([401, 602, 606]);

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
  // A string counts only when the whole string is a decimal number. The
  // lenient parse read "0x1F" as 0 and "8080x" as 8080 — and then acted on a
  // port the caller never named.
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < lowest || port > 65535) {
    throw new Error(
      `${what} must be an integer between ${lowest} and 65535, got ${JSON.stringify(value)}`
    );
  }
  return port;
}

/**
 * The address a new mapping points at. A failed route query resolves the
 * local address to "" — and an empty NewInternalClient gets a baffling 402
 * from strict firmware, or a mapping to nothing reported as success from
 * lenient firmware. The absence is an error before the wire, not an element.
 */
function isIPv4Location(location: string): boolean {
  try {
    return net.isIPv4(new URL(location).hostname);
  } catch {
    return false;
  }
}

function internalClientFor(host: string | undefined, localAddress: string): string {
  const client = host || localAddress;
  if (!client) {
    throw new Error(
      "No internal client address: none was given and the local address could not be determined"
    );
  }
  return client;
}

/**
 * A lease duration is ui4 on the wire and gets the port treatment: a
 * truncating firmware maps a lease the caller never asked for and answers
 * success, and nothing read back can reveal it.
 */
/**
 * A table index is ui2 on the wire, and gets the port treatment: a firmware
 * that truncates it answers about an entry the caller never asked for.
 */
function validIndex(value: unknown): number {
  const index = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 65535) {
    throw new Error(`index must be an integer between 0 and 65535, got ${JSON.stringify(value)}`);
  }
  return index;
}

function validTtl(value: unknown, what: string): number {
  const ttl = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > 4294967295) {
    throw new Error(
      `${what} must be an integer between 0 and 4294967295, got ${JSON.stringify(value)}`
    );
  }
  return ttl;
}

function validProtocol(value: string | undefined): string {
  const protocol = (value ?? "TCP").toUpperCase();
  if (protocol !== "TCP" && protocol !== "UDP") {
    throw new Error(`protocol must be TCP or UDP, got ${JSON.stringify(value)}`);
  }
  return protocol;
}

function normalizeOptions(options: StandardOpts, lowestPort: 0 | 1 = 1) {
  // Ports pass through untouched — validPort is the single place a string
  // becomes a number, so no path can reacquire a lenient parse.
  function toObject(addr: StandardOpts["public"]): { port?: number | string; host?: string } {
    if (typeof addr === "number" || typeof addr === "string") return { port: addr };
    // A copy: the internal-port default below must not write into the
    // caller's own object.
    if (typeof addr === "object" && addr !== null) return { ...addr };
    return {};
  }

  const remote = toObject(options.public);
  const internal = toObject(options.private);

  if (internal.port === undefined && remote.port !== undefined) {
    internal.port = remote.port;
  }

  return {
    remote: { host: remote.host, port: validPort(remote.port, "public port", lowestPort) },
    internal: { host: internal.host, port: validPort(internal.port, "private port", lowestPort) },
  };
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
    // Descriptions are escaped on the way out and the SOAP parser leaves
    // entities alone for XXE protection, so the free-text field is decoded
    // here — otherwise a description never reads back as it was written.
    description: decodeXmlEntities(fieldValue(res.NewPortMappingDescription)),
    ttl: parseInt(fieldValue(res.NewLeaseDuration), 10) || 0,
    local: isLocal(host, localAddress),
  };
}

function findResponseKey(data: RawResponse, prefix: string): any | null {
  if (!data || typeof data !== "object") return null;
  const key = Object.keys(data).find((k) => k.startsWith(prefix));
  return key ? data[key] : null;
}

/**
 * A mapping description as routers keep it, whatever they did to its
 * punctuation: every run of characters other than letters and digits becomes
 * one underscore. FRITZ!Box stores "Flux_App_web" as "Flux.App.web" and
 * "FluxOS Reserved" as "FluxOS.Reserved"; all three forms of each compare
 * equal here. Compare descriptions a router has stored this way, never as
 * they were sent.
 */
export function canonicalDescription(description: string): string {
  return String(description ?? "").replace(/[^A-Za-z0-9]+/g, "_");
}

function matchesDescription(desc: string, filter: RegExp | string): boolean {
  if (typeof desc !== "string") return false;
  if (filter instanceof RegExp) return filter.test(desc);
  return canonicalDescription(desc).includes(canonicalDescription(filter));
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

export interface StandardOpts extends RequestOpts {
  public?: number | { port?: number; host?: string };
  private?: number | { port?: number; host?: string };
  protocol?: string;
}

export interface NewPortMappingOpts extends StandardOpts {
  description?: string;
  ttl?: number;
}

export type DeletePortMappingOpts = StandardOpts;

export interface GetMappingOpts extends RequestOpts {
  local?: boolean;
  description?: RegExp | string;
}

export interface GetMappingAtOpts extends RequestOpts {
  index: number;
}

export interface GetSpecificMappingOpts extends RequestOpts {
  public: number;
  protocol?: string;
  remoteHost?: string;
}

export interface DeleteMappingRangeOpts extends RequestOpts {
  startPort: number;
  endPort: number;
  protocol?: string;
  manage?: boolean;
}

export interface GetMappingRangeOpts extends RequestOpts {
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
  /**
   * Keep the discovered gateway between calls. A request to it that fails
   * with anything but a UPnP fault drops it, finds the router again, and sends
   * the request once more if the router now answers at a different location.
   */
  cacheGateway?: boolean;
}

export interface IClient {
  url: string | null;
  createMapping(options: NewPortMappingOpts): Promise<RawResponse>;
  createAnyMapping(options: NewPortMappingOpts): Promise<{ reservedPort: number }>;
  removeMapping(options: DeletePortMappingOpts): Promise<RawResponse>;
  removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse>;
  getMappings(options?: GetMappingOpts): Promise<Mapping[]>;
  getMappingAt(options: GetMappingAtOpts): Promise<Mapping | null>;
  getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]>;
  getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null>;
  getStatusInfo(options?: RequestOpts): Promise<StatusInfo>;
  getPublicIp(options?: RequestOpts): Promise<string>;
  getGateway(options?: RequestOpts): Promise<UpnpInfo>;
  close(): void;
}
