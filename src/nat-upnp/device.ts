import axios from "axios";
import dgram from "dgram";
import http from "http";
import { URL } from "url";
import { XMLParser } from "fast-xml-parser";

import { RawResponse } from "../index";

// Shared XML parser with XXE protection.
export const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  processEntities: false,
});

// UPnP devices (especially miniupnpd) always respond with Connection: close.
// Node.js 19+ defaults to keepAlive: true on the global agent, which causes
// "socket hang up" errors when trying to reuse connections the server already closed.
const upnpAgent = new http.Agent({ keepAlive: false });

// Prevent OOM from malicious/broken router responses
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const axiosDefaults = {
  httpAgent: upnpAgent,
  maxContentLength: MAX_RESPONSE_BYTES,
  maxBodyLength: MAX_RESPONSE_BYTES,
};

export class Device implements IDevice {
  readonly description: string;
  readonly services: string[];

  // Lazy-init promises — concurrent callers share the same promise
  private descriptionPromise: Promise<any> | null = null;
  private servicePromise: Promise<ResolvedService> | null = null;
  private deviceInfoPromise: Promise<GatewayDevice | null> | null = null;
  private capabilitiesPromise: Promise<ServiceCapabilities | null> | null = null;
  private localAddressPromise: Promise<string> | null = null;

  constructor(url: string) {
    this.description = url;
    this.services = [
      "urn:schemas-upnp-org:service:WANIPConnection:2",
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];
  }

  /**
   * Fetch and parse the root device description XML.
   * Concurrent calls share one promise.
   */
  private fetchDescription(): Promise<any> {
    if (!this.descriptionPromise) {
      this.descriptionPromise = axios
        .get(this.description, axiosDefaults)
        .then(({ data }) => xmlParser.parse(data));
    }
    return this.descriptionPromise;
  }

  /**
   * Determine the local interface address used to reach this device.
   * Uses UDP connect (zero-packet kernel route query) — the standard technique
   * used by miniupnpc, Python, Go, Docker, and Kubernetes.
   * Cached after first call.
   */
  public getLocalAddress(): Promise<string> {
    if (!this.localAddressPromise) {
      const routerIp = new URL(this.description).hostname;
      this.localAddressPromise = resolveLocalAddress(routerIp);
    }
    return this.localAddressPromise;
  }

  /**
   * Parse device info from rootDesc.xml. Returns null on failure.
   */
  public getDeviceInfo(): Promise<GatewayDevice | null> {
    if (!this.deviceInfoPromise) {
      this.deviceInfoPromise = this.buildDeviceInfo().catch(() => null);
    }
    return this.deviceInfoPromise;
  }

  private async buildDeviceInfo(): Promise<GatewayDevice> {
    const parsed = await this.fetchDescription();
    const root = parsed?.root || {};
    const device = root.device || {};
    const { devices } = this.parseDescription({ device });

    const info: GatewayDevice = {
      friendlyName: String(device.friendlyName ?? ""),
      manufacturer: String(device.manufacturer ?? ""),
      manufacturerURL: String(device.manufacturerURL ?? ""),
      modelDescription: String(device.modelDescription ?? ""),
      modelName: String(device.modelName ?? ""),
      modelNumber: String(device.modelNumber ?? ""),
      modelURL: String(device.modelURL ?? ""),
      serialNumber: String(device.serialNumber ?? ""),
      UDN: String(device.UDN ?? ""),
      presentationURL: String(device.presentationURL ?? ""),
      specVersion: {
        major: Number(root.specVersion?.major) || 0,
        minor: Number(root.specVersion?.minor) || 0,
      },
      configId: root["@_configId"] ? String(root["@_configId"]) : null,
      descriptionURL: this.description,
    };

    const wanDevice = devices.find(
      (d) =>
        d.deviceType?.includes("WANDevice") ||
        d.deviceType?.includes("WANConnectionDevice")
    );
    if (wanDevice && wanDevice !== device) {
      info.wan = {
        manufacturer: String(wanDevice.manufacturer ?? ""),
        modelDescription: String(wanDevice.modelDescription ?? ""),
        modelName: String(wanDevice.modelName ?? ""),
        modelNumber: String(wanDevice.modelNumber ?? ""),
      };
    }

    return info;
  }

  /**
   * Fetch and parse the SCPD to discover supported actions. Returns null on failure.
   */
  public getCapabilities(): Promise<ServiceCapabilities | null> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.buildCapabilities().catch(() => null);
    }
    return this.capabilitiesPromise;
  }

  private async buildCapabilities(): Promise<ServiceCapabilities | null> {
    const service = await this.resolveService();

    let parsed: any;
    try {
      const { data } = await axios.get(service.SCPDURL, axiosDefaults);
      parsed = xmlParser.parse(data);
    } catch {
      return null;
    }

    const actionList = parsed?.scpd?.actionList?.action;
    const actions: string[] = [];
    if (Array.isArray(actionList)) {
      for (const a of actionList) {
        if (a?.name) actions.push(String(a.name));
      }
    } else if (actionList?.name) {
      actions.push(String(actionList.name));
    }

    const actionSet = new Set(actions);
    const versionMatch = service.service.match(/:(\d+)$/);
    const serviceVersion = versionMatch ? parseInt(versionMatch[1], 10) : 1;

    return {
      serviceType: service.service,
      serviceVersion,
      controlURL: service.controlURL,
      actions,
      supportsAddAnyPortMapping: actionSet.has("AddAnyPortMapping"),
      supportsDeletePortMappingRange: actionSet.has("DeletePortMappingRange"),
      supportsGetListOfPortMappings: actionSet.has("GetListOfPortMappings"),
      supportsGetSpecificPortMappingEntry: actionSet.has("GetSpecificPortMappingEntry"),
      supportsGetStatusInfo: actionSet.has("GetStatusInfo"),
    };
  }

  /**
   * Resolve the service control URL. Prefers v2 > v1 > PPP.
   */
  private resolveService(): Promise<ResolvedService> {
    if (!this.servicePromise) {
      this.servicePromise = this.buildResolvedService();
    }
    return this.servicePromise;
  }

  private async buildResolvedService(): Promise<ResolvedService> {
    const parsed = await this.fetchDescription();
    const root = parsed?.root;
    if (!root) throw new Error("Invalid device description: no root element");

    const allServices = this.parseDescription(root).services;

    let matched: RawService | undefined;
    for (const preferred of this.services) {
      matched = allServices.find((s) => s.serviceType === preferred);
      if (matched) break;
    }

    if (!matched?.controlURL || !matched?.SCPDURL) {
      const available = allServices.map((s) => s.serviceType).join(", ");
      throw new Error(`UPnP service not found. Available: ${available || "none"}`);
    }

    const baseUrl = new URL(root.baseURL || "", this.description);
    const prefix = (url: string) =>
      new URL(url, baseUrl.toString()).toString();

    return {
      service: matched.serviceType,
      SCPDURL: prefix(matched.SCPDURL),
      controlURL: prefix(matched.controlURL),
    };
  }

  public async getService(types: string[]): Promise<ResolvedService> {
    return this.resolveService();
  }

  public async run(
    action: string,
    args: (string | number)[][]
  ): Promise<RawResponse> {
    const info = await this.resolveService();

    const argsXml = args
      .map(([name, value]) => `<${name}>${escapeXml(String(value ?? ""))}</${name}>`)
      .join("");

    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      "<s:Body>" +
      `<u:${action} xmlns:u=${JSON.stringify(info.service)}>` +
      argsXml +
      `</u:${action}>` +
      "</s:Body>" +
      "</s:Envelope>";

    let responseData: string;

    try {
      const response = await axios.post(info.controlURL, body, {
        ...axiosDefaults,
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          "Content-Length": "" + Buffer.byteLength(body),
          SOAPAction: JSON.stringify(info.service + "#" + action),
        },
      });
      responseData = response.data;
    } catch (err: any) {
      if (err?.response?.data) {
        throwIfSoapFault(err.response.data, action);
      }
      throw err;
    }

    let parsed: any;
    try {
      parsed = xmlParser.parse(responseData);
    } catch {
      throw new Error(`Malformed XML response for ${action}`);
    }

    const soapBody = parsed?.Envelope?.Body;
    if (!soapBody) {
      throw new Error(`Malformed SOAP envelope for ${action}`);
    }

    if (soapBody.Fault) {
      throwSoapFault(soapBody.Fault, action);
    }

    return soapBody;
  }

  public parseDescription(info: { device?: RawDevice }): {
    services: RawService[];
    devices: RawDevice[];
  } {
    const services: RawService[] = [];
    const devices: RawDevice[] = [];

    function traverseDevices(device?: RawDevice) {
      if (!device || typeof device !== "object") return;

      devices.push(device);

      const serviceList = device.serviceList?.service;
      if (serviceList) {
        const items = Array.isArray(serviceList) ? serviceList : [serviceList];
        for (const svc of items) {
          if (svc && typeof svc === "object" && svc.serviceType) {
            services.push(svc);
          }
        }
      }

      const deviceList = device.deviceList?.device;
      if (deviceList) {
        const items = Array.isArray(deviceList) ? deviceList : [deviceList];
        items.forEach(traverseDevices);
      }
    }

    traverseDevices(info.device);
    return { services, devices };
  }
}

export default Device;

/*
 * =======================
 * ====== Utilities ======
 * =======================
 */

/**
 * Determine which local interface address the OS would use to reach a remote IP.
 * Uses UDP connect — a zero-packet kernel route query. The standard technique used
 * by miniupnpc, Python, Go, Docker, and Kubernetes.
 * No data is sent on the wire.
 */
function resolveLocalAddress(remoteIp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.connect(80, remoteIp, () => {
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });
    socket.on("error", (err) => {
      try { socket.close(); } catch { /* already closed */ }
      reject(err);
    });
  });
}

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch]);
}

function extractFaultInfo(fault: any): { code: number; description: string } {
  const rawCode = fault?.detail?.UPnPError?.errorCode;
  const rawDesc = fault?.detail?.UPnPError?.errorDescription;
  return {
    code: rawCode ? Number(rawCode) || 0 : 0,
    description: rawDesc ? String(rawDesc) : String(fault?.faultstring || "Unknown UPnP error"),
  };
}

function throwSoapFault(fault: any, action: string): never {
  const { code, description } = extractFaultInfo(fault);
  throw new UpnpError(code, description, action);
}

function throwIfSoapFault(data: string, action: string): void {
  try {
    const parsed = xmlParser.parse(data);
    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throwSoapFault(fault, action);
  } catch (err) {
    if (err instanceof UpnpError) throw err;
  }
}

/*
 * ==================
 * ====== Errors ====
 * ==================
 */

export class UpnpError extends Error {
  readonly code: number;
  readonly description: string;
  readonly action: string;

  constructor(code: number, description: string, action: string) {
    super(`UPnP error ${code}: ${description} (action: ${action})`);
    this.name = "UpnpError";
    this.code = Number(code) || 0;
    this.description = String(description || "Unknown");
    this.action = String(action || "Unknown");
  }
}

/*
 * ===================
 * ====== Types ======
 * ===================
 */

export interface GatewayDevice {
  friendlyName: string;
  manufacturer: string;
  manufacturerURL: string;
  modelDescription: string;
  modelName: string;
  modelNumber: string;
  modelURL: string;
  serialNumber: string;
  UDN: string;
  presentationURL: string;
  specVersion: { major: number; minor: number };
  configId: string | null;
  descriptionURL: string;
  wan?: {
    manufacturer: string;
    modelDescription: string;
    modelName: string;
    modelNumber: string;
  };
}

export interface ServiceCapabilities {
  serviceType: string;
  serviceVersion: number;
  controlURL: string;
  actions: string[];

  supportsAddAnyPortMapping: boolean;
  supportsDeletePortMappingRange: boolean;
  supportsGetListOfPortMappings: boolean;
  supportsGetSpecificPortMappingEntry: boolean;
  supportsGetStatusInfo: boolean;
}

export interface ResolvedService {
  service: string;
  SCPDURL: string;
  controlURL: string;
}

export interface RawService {
  serviceType: string;
  serviceId: string;
  controlURL?: string;
  eventSubURL?: string;
  SCPDURL?: string;
}

export interface RawDevice {
  deviceType: string;
  presentationURL: string;
  friendlyName: string;
  manufacturer: string;
  manufacturerURL: string;
  modelDescription: string;
  modelName: string;
  modelNumber: string;
  modelURL: string;
  serialNumber: string;
  UDN: string;
  UPC: string;
  serviceList?: { service: RawService | RawService[] };
  deviceList?: { device: RawDevice | RawDevice[] };
}

export interface IDevice {
  getService(types: string[]): Promise<ResolvedService>;
  getDeviceInfo(): Promise<GatewayDevice | null>;
  getCapabilities(): Promise<ServiceCapabilities | null>;
  getLocalAddress(): Promise<string>;
  parseDescription(info: { device?: RawDevice }): {
    services: RawService[];
    devices: RawDevice[];
  };
  run(action: string, kvpairs: (string | number)[][]): Promise<RawResponse>;
}
