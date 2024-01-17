import { RawResponse } from "../index";
import Device from "./device";
import Ssdp from "./ssdp";

export class Client implements IClient {
  private readonly timeout: number;
  private readonly ssdp = new Ssdp();
  private readonly localAddress: string | null;
  private readonly cacheGateway: boolean
  private upnpInfo: upnpInfo | null = null;

  url: string | null;

  constructor(options: { timeout?: number, url?: string, localAddress?: string, cacheGateway?: boolean } = {}) {
    if (options.url && !(options.localAddress)) {
      throw new Error("`localAddress` must be supplied if using `url`");
    }

    this.timeout = options.timeout || 1800;
    this.url = options.url || null;
    this.localAddress = options.localAddress || null;
    this.cacheGateway = options.cacheGateway || false;
  }

  public async createMapping(
    options: NewPortMappingOpts
  ): Promise<RawResponse> {
    return this.getGateway().then(({ gateway, localAddress }) => {
      const ports = normalizeOptions(options);

      if (typeof ports.remote.host === 'undefined') ports.remote.host = "";

      return gateway.run("AddPortMapping", [
        ["NewRemoteHost", ports.remote.host + ""],
        ["NewExternalPort", ports.remote.port + ""],
        [
          "NewProtocol",
          options.protocol ? options.protocol.toUpperCase() : "TCP",
        ],
        ["NewInternalPort", ports.internal.port + ""],
        ["NewInternalClient", ports.internal.host || localAddress],
        ["NewEnabled", 1],
        ["NewPortMappingDescription", options.description || "node:nat:upnp"],
        ["NewLeaseDuration", options.ttl ?? 60 * 30],
      ]);
    });
  }

  public async removeMapping(
    options: DeletePortMappingOpts
  ): Promise<RawResponse> {
    return this.getGateway().then(({ gateway }) => {
      const ports = normalizeOptions(options);

      if (typeof ports.remote.host === 'undefined') ports.remote.host = "";

      return gateway.run("DeletePortMapping", [
        ["NewRemoteHost", ports.remote.host + ""],
        ["NewExternalPort", ports.remote.port + ""],
        [
          "NewProtocol",
          options.protocol ? options.protocol.toUpperCase() : "TCP",
        ],
      ]);
    });
  }

  public async getMappings(options: GetMappingOpts = {}) {
    const { gateway, localAddress } = await this.getGateway();
    let i = 0;
    let end = false;
    const results = [];

    while (true) {
      const data = (await gateway
        .run("GetGenericPortMappingEntry", [["NewPortMappingIndex", i++]])
        .catch((err) => {
          if (i !== 1 || /ArrayIndexInvalid/.test(err?.response?.data)) {
            end = true;
          }
        }))!;

      if (end) break;

      const key = Object.keys(data || {}).find((k) =>
        /^GetGenericPortMappingEntryResponse/.test(k)
      );

      if (!key) {
        throw new Error("Incorrect response");
      }

      const res: any = data[key];

      const result: Mapping = {
        public: {
          host:
            (typeof res.NewRemoteHost === "string" && res.NewRemoteHost) || "",
          port: parseInt(res.NewExternalPort, 10),
        },
        private: {
          host: res.NewInternalClient,
          port: parseInt(res.NewInternalPort, 10),
        },
        protocol: res.NewProtocol.toLowerCase(),
        enabled: res.NewEnabled === "1",
        description: res.NewPortMappingDescription,
        ttl: parseInt(res.NewLeaseDuration, 10),
        // temporary, so typescript will compile
        local: false,
      };
      result.local = result.private.host === localAddress;

      if (options.local && !result.local) {
        continue;
      }

      if (options.description) {
        if (typeof result.description !== "string") continue;

        if (options.description instanceof RegExp) {
          if (!options.description.test(result.description)) continue;
        } else {
          if (result.description.indexOf(options.description) === -1) continue;
        }
      }

      results.push(result);
    }

    return results;
  }

  public async getPublicIp(): Promise<string> {
    return this.getGateway().then(async ({ gateway, localAddress }) => {
      const data = await gateway.run("GetExternalIPAddress", []);

      const key = Object.keys(data || {}).find((k) =>
        /^GetExternalIPAddressResponse$/.test(k)
      );

      if (!key) throw new Error("Incorrect response");
      return data[key]?.NewExternalIPAddress + "";
    });
  }

  public async getGateway(): Promise<upnpInfo> {
    if (this.url) {
      if (!this.upnpInfo) {
        this.upnpInfo = { gateway: new Device(this.url), localAddress: this.localAddress! };
      }
      // resolve immediately without running SSDP.
      return Promise.resolve(this.upnpInfo);
    }

    let timeouted = false;
    const p = this.ssdp.search(
      "urn:schemas-upnp-org:device:InternetGatewayDevice:1"
    );

    return new Promise<upnpInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        timeouted = true;
        p.emit("end");
        // this will only happen after at least one call. (If cacheGateway is set below)
        if (this.upnpInfo) {
          resolve(this.upnpInfo);
        }
        reject(new Error("Connection timed out while searching for the gateway."));
      }, this.timeout);
      p.on("device", (info, localAddress) => {
        if (timeouted) return;
        p.emit("end");
        clearTimeout(timeout);
        const upnpInfo = { gateway: new Device(info.location), localAddress }
        if (this.cacheGateway) {
          this.upnpInfo = upnpInfo;
        }
        resolve(upnpInfo);
      });
    });
  }

  public close() {
    this.ssdp.close();
  }
}

function normalizeOptions(options: StandardOpts) {
  function toObject(addr: StandardOpts["public"]) {
    if (typeof addr === "number") return { port: addr };
    if (typeof addr === "string" && !isNaN(addr)) return { port: Number(addr) };
    if (typeof addr === "object") return addr;

    return {};
  }

  return {
    remote: toObject(options.public),
    internal: toObject(options.private),
  };
}

export default Client;

/*
 * ===================
 * ====== Types ======
 * ===================
 */

export interface Mapping {
  public: { host: string; port: number };
  private: { host: string; port: number };
  protocol: string;
  enabled: boolean;
  description: string;
  ttl: number;
  local: boolean;
}

/**
 * Standard options that many options use.
 */
export interface StandardOpts {
  public?:
    | number
    | {
        port?: number;
        host?: string;
      };
  private?:
    | number
    | {
        port?: number;
        host?: string;
      };
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

export interface upnpInfo {
  gateway: Device;
  localAddress: string;
}

/**
 * Main client interface.
 */
export interface IClient {
  /**
   * Allows bypass of SSDP in situations with multicast issues
  */
  url: string | null;
  /**
   * Create a new port mapping
   * @param options Options for the new port mapping
   */
  createMapping(options: NewPortMappingOpts): Promise<RawResponse>;
  /**
   * Remove a port mapping
   * @param options Specify which port mapping to remove
   */
  removeMapping(options: DeletePortMappingOpts): Promise<RawResponse>;
  /**
   * Get a list of existing mappings
   * @param options Filter mappings based on these options
   */
  getMappings(options?: GetMappingOpts): Promise<Mapping[]>;
  /**
   * Fetch the external/public IP from the gateway
   */
  getPublicIp(): Promise<string>;
  /**
   * Get the gateway device for communication
   */
  getGateway(): Promise<upnpInfo>;
  /**
   * Close the underlaying sockets and resources
   */
  close(): void;
}
