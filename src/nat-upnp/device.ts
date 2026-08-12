import axios from "axios";
import dgram from "dgram";
import http from "http";
import net from "net";
import { URL } from "url";
import { XMLParser } from "fast-xml-parser";

import { RawResponse } from "../index";

// Shared XML parser with XXE protection.
export const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  processEntities: false,
  parseTagValue: false,
});

/**
 * Decode the five entities XML predefines.
 *
 * The parser runs with processEntities disabled so a hostile description cannot
 * declare entities of its own — that is the XXE defence and it stays. But the
 * switch is all-or-nothing, so ordinary escaped text came back raw and a router
 * named "OPNsense UPnP IGD &amp; PCP" read back with the escape still in it.
 * These five expand to plain characters and reference nothing, so decoding them
 * afterwards restores the text without reopening anything.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_match, name) => {
    switch (name) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

/**
 * Read a value out of a parsed response.
 *
 * A router may attach attributes to a value element — the YAMAHA RTX810 tags
 * its results with Microsoft datatype attributes — and the parser then returns
 * an object with the value under `#text` rather than a bare string. Coercing
 * that with String() yields "[object Object]", so the text has to be reached
 * for explicitly.
 */
export function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return text === undefined || text === null ? "" : String(text);
  }
  return String(value);
}

/** Read a router-supplied text field, undoing the escaping the parser left. */
function text(value: unknown): string {
  return decodeXmlEntities(fieldValue(value));
}

// UPnP devices (especially miniupnpd) always respond with Connection: close.
// Node.js 19+ defaults to keepAlive: true on the global agent, which causes
// "socket hang up" errors when trying to reuse connections the server already closed.
const upnpAgent = new http.Agent({ keepAlive: false });

// Prevent OOM from malicious/broken router responses
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const axiosDefaults = {
  httpAgent: upnpAgent,
  timeout: 10000,
  maxContentLength: MAX_RESPONSE_BYTES,
  maxBodyLength: MAX_RESPONSE_BYTES,
  maxRedirects: 2,
};

export class Device implements IDevice {
  readonly description: string;
  readonly services: readonly string[];

  // Lazy-init promises — concurrent callers share the same promise.
  // On error, the cache is cleared so subsequent calls retry.
  private descriptionPromise: Promise<Record<string, unknown>> | null = null;
  private servicePromise: Promise<ResolvedService> | null = null;
  private deviceInfoPromise: Promise<GatewayDevice | null> | null = null;
  private capabilitiesPromise: Promise<ServiceCapabilities | null> | null = null;
  private localAddressPromise: Promise<string> | null = null;

  constructor(url: string) {
    if (!url.startsWith("http")) {
      throw new Error(`Invalid UPnP device URL: ${url}`);
    }
    this.description = url;
    // Preference order: v2 first, then v1, then PPP
    this.services = [
      "urn:schemas-upnp-org:service:WANIPConnection:2",
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];
  }

  /**
   * Fetch and parse the root device description XML.
   * Concurrent calls share one promise. Clears cache on error to allow retry.
   */
  private fetchDescription(): Promise<Record<string, unknown>> {
    if (!this.descriptionPromise) {
      this.descriptionPromise = axios
        .get(this.description, axiosDefaults)
        .then(({ data }) => xmlParser.parse(data) as Record<string, unknown>)
        .catch((err) => {
          this.descriptionPromise = null;
          throw err;
        });
    }
    return this.descriptionPromise;
  }

  /**
   * Determine the local interface address used to reach this device.
   * Uses UDP connect — a zero-packet kernel route query. The standard technique
   * used by miniupnpc (C), Python, Go, Docker, and Kubernetes.
   * No data is sent on the wire. Cached after first success; cleared on failure.
   */
  public getLocalAddress(): Promise<string> {
    if (!this.localAddressPromise) {
      const hostname = new URL(this.description).hostname;
      if (!hostname || !net.isIPv4(hostname)) {
        // If hostname is IPv6 or a DNS name, fall back to resolving via the description
        // URL host directly. For IPv6, we'd need a udp6 socket.
        this.localAddressPromise = Promise.resolve("");
      } else {
        this.localAddressPromise = resolveLocalAddress(hostname).catch(() => {
          this.localAddressPromise = null;
          return "";
        });
      }
    }
    return this.localAddressPromise;
  }

  /**
   * Parse device info from rootDesc.xml. Returns null on failure.
   * Cached after first success; cleared on failure to allow retry.
   */
  public getDeviceInfo(): Promise<GatewayDevice | null> {
    if (!this.deviceInfoPromise) {
      this.deviceInfoPromise = this.buildDeviceInfo().catch((err) => {
        this.deviceInfoPromise = null;
        return null;
      });
    }
    return this.deviceInfoPromise;
  }

  private async buildDeviceInfo(): Promise<GatewayDevice> {
    const parsed = await this.fetchDescription();
    const root = (parsed as any)?.root || {};
    const device = root.device || {};
    const { devices } = this.parseDescription({ device });

    const info: GatewayDevice = {
      friendlyName: text(device.friendlyName),
      manufacturer: text(device.manufacturer),
      manufacturerURL: String(device.manufacturerURL ?? ""),
      modelDescription: text(device.modelDescription),
      modelName: text(device.modelName),
      modelNumber: text(device.modelNumber),
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
        manufacturer: text(wanDevice.manufacturer),
        modelDescription: text(wanDevice.modelDescription),
        modelName: text(wanDevice.modelName),
        modelNumber: text(wanDevice.modelNumber),
      };
    }

    return info;
  }

  /**
   * Fetch and parse the SCPD to discover supported actions. Returns null on failure.
   * Cached after first success; cleared on failure to allow retry.
   */
  public getCapabilities(): Promise<ServiceCapabilities | null> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.buildCapabilities().catch(() => {
        this.capabilitiesPromise = null;
        return null;
      });
    }
    return this.capabilitiesPromise;
  }

  private async buildCapabilities(): Promise<ServiceCapabilities | null> {
    const service = await this.resolveService();

    let parsed: Record<string, unknown>;
    try {
      const { data } = await axios.get(service.SCPDURL, axiosDefaults);
      parsed = xmlParser.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }

    const scpd = parsed as any;
    const actionList = scpd?.scpd?.actionList?.action;
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
   * Cached after first success; cleared on failure to allow retry.
   */
  private resolveService(): Promise<ResolvedService> {
    if (!this.servicePromise) {
      this.servicePromise = this.buildResolvedService().catch((err) => {
        this.servicePromise = null;
        throw err;
      });
    }
    return this.servicePromise;
  }

  private async buildResolvedService(): Promise<ResolvedService> {
    const parsed = await this.fetchDescription();
    const root = (parsed as any)?.root;
    if (!root) {
      throw new Error(
        `Invalid device description from ${this.description}: no root element`
      );
    }

    const allServices = this.parseDescription(root).services;

    let matched: RawService | undefined;
    for (const preferred of this.services) {
      matched = allServices.find((s) => s.serviceType === preferred);
      if (matched) break;
    }

    if (!matched?.controlURL || !matched?.SCPDURL) {
      const available = allServices.map((s) => s.serviceType).join(", ");
      throw new Error(
        `UPnP service not found on ${this.description}. Available: ${available || "none"}`
      );
    }

    // The element is <URLBase>; anything else resolves relative URLs against
    // the description URL instead, which is wrong whenever a router serves its
    // control endpoint from a different host or port.
    const baseUrl = new URL(root.URLBase ?? "", this.description);
    const prefix = (url: string) =>
      new URL(url, baseUrl.toString()).toString();

    return {
      service: matched.serviceType,
      SCPDURL: prefix(matched.SCPDURL),
      controlURL: prefix(matched.controlURL),
    };
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
    } catch (err: unknown) {
      if (isAxiosErrorWithData(err)) {
        throwIfSoapFault(err.response.data, action);
      }
      throw err;
    }

    const parsed = xmlParser.parse(responseData) as Record<string, unknown>;

    const soapBody = (parsed as any)?.Envelope?.Body;
    if (!soapBody) {
      throw new Error(
        `Malformed SOAP envelope in ${action} response from ${info.controlURL}`
      );
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

    function traverseDevices(device?: RawDevice, depth = 0) {
      if (!device || typeof device !== "object" || depth > 10) return;

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
        items.forEach((d) => traverseDevices(d, depth + 1));
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
 * Uses UDP connect — a zero-packet kernel route query. No data is sent on the wire.
 * This is the standard technique used by miniupnpc (C), Python's socket module,
 * Go's net.Dial, Docker, and Kubernetes for local address resolution.
 */
function resolveLocalAddress(remoteIp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error(`resolveLocalAddress timed out for ${remoteIp}`));
      }
    }, 5000);

    socket.connect(80, remoteIp, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      reject(err);
    });
  });
}

function isAxiosErrorWithData(err: unknown): err is { response: { data: string } } {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as any).response?.data === "string"
  );
}

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape XML special characters in SOAP argument values to prevent injection. */
function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch]);
}

function extractFaultInfo(fault: Record<string, unknown>): { code: number; description: string } {
  const detail = fault?.detail as Record<string, unknown> | undefined;
  const upnpError = detail?.UPnPError as Record<string, unknown> | undefined;
  const rawCode = upnpError?.errorCode;
  const rawDesc = upnpError?.errorDescription;
  return {
    code: rawCode ? Number(rawCode) || 0 : 0,
    // MikroTik spells the SOAP fault tags faultCode/faultString rather than the
    // spec's lowercase, so a fault of theirs without a UPnPError detail would
    // otherwise lose its description entirely.
    description: rawDesc
      ? text(rawDesc)
      : text((fault as any)?.faultstring || (fault as any)?.faultString || "Unknown UPnP error"),
  };
}

function throwSoapFault(fault: Record<string, unknown>, action: string): never {
  const { code, description } = extractFaultInfo(fault);
  throw new UpnpError(code, description, action);
}

function throwIfSoapFault(data: string, action: string): void {
  try {
    const parsed = xmlParser.parse(data) as any;
    const fault = parsed?.Envelope?.Body?.Fault;
    if (fault) throwSoapFault(fault, action);
  } catch (err) {
    if (err instanceof UpnpError) throw err;
    // XML parsing failed — not a SOAP fault, let caller handle original error
  }
}

/*
 * ==================
 * ====== Errors ====
 * ==================
 */

/**
 * Structured UPnP error with numeric error code.
 *
 * Common error codes:
 * - 402: Invalid Args
 * - 501: Action Failed
 * - 606: Action Not Authorized
 * - 714: NoSuchEntryInArray
 * - 718: ConflictInMappingEntry
 * - 725: OnlyPermanentLeasesSupported
 * - 728: NoPortMapsAvailable
 * - 729: ConflictWithOtherMechanisms
 */
/**
 * The UPnP error codes, as the specification defines them.
 *
 * The number is the reliable part. Routers word the description themselves and
 * do not agree: across a fleet survey, 713 arrived as both
 * "SpecifiedArrayIndexInvalid" and "Bad Array Index", 714 as both
 * "NoSuchEntryInArray" and "No Such Entry", and 402 as both "Invalid Args" and
 * "Invalid NewPortMappingIndex". Match on `UpnpError.code`, never on the text,
 * and use this table when a code needs explaining to a human.
 *
 * Routers also differ on which code they use for a situation — MikroTik ends a
 * mapping walk with 402 where most send 713 — so this gives the specified
 * meaning, not a guarantee of what a particular router meant by it.
 */
export const UPNP_ERROR_CODES: Readonly<Record<number, string>> = Object.freeze({
  401: "Invalid Action",
  402: "Invalid Args",
  501: "Action Failed",
  606: "Action Not Authorized",
  713: "Specified Array Index Invalid",
  714: "No Such Entry In Array",
  715: "Wildcard Not Permitted In Source IP",
  716: "Wildcard Not Permitted In External Port",
  718: "Conflict In Mapping Entry",
  724: "Same Port Values Required",
  725: "Only Permanent Leases Supported",
  726: "Remote Host Only Supports Wildcard",
  727: "External Port Only Supports Wildcard",
});

/** The router accepts permanent mappings only, so a timed lease is refused. */
export const ONLY_PERMANENT_LEASES = 725;

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
  readonly friendlyName: string;
  readonly manufacturer: string;
  readonly manufacturerURL: string;
  readonly modelDescription: string;
  readonly modelName: string;
  readonly modelNumber: string;
  readonly modelURL: string;
  readonly serialNumber: string;
  readonly UDN: string;
  readonly presentationURL: string;
  readonly specVersion: { readonly major: number; readonly minor: number };
  readonly configId: string | null;
  readonly descriptionURL: string;
  wan?: {
    readonly manufacturer: string;
    readonly modelDescription: string;
    readonly modelName: string;
    readonly modelNumber: string;
  };
}

export interface ServiceCapabilities {
  readonly serviceType: string;
  readonly serviceVersion: number;
  readonly controlURL: string;
  readonly actions: readonly string[];

  readonly supportsAddAnyPortMapping: boolean;
  readonly supportsDeletePortMappingRange: boolean;
  readonly supportsGetListOfPortMappings: boolean;
  readonly supportsGetSpecificPortMappingEntry: boolean;
  readonly supportsGetStatusInfo: boolean;
}

export interface ResolvedService {
  readonly service: string;
  readonly SCPDURL: string;
  readonly controlURL: string;
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
  getDeviceInfo(): Promise<GatewayDevice | null>;
  getCapabilities(): Promise<ServiceCapabilities | null>;
  getLocalAddress(): Promise<string>;
  parseDescription(info: { device?: RawDevice }): {
    services: RawService[];
    devices: RawDevice[];
  };
  run(action: string, kvpairs: (string | number)[][]): Promise<RawResponse>;
}
