import axios from "axios";
import http from "http";
import type { Socket } from "net";
import net from "net";
import type { Readable } from "stream";
import { URL } from "url";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { RawResponse } from "../index";
import { resolveLocalAddress } from "./route";

// Shared XML parser with XXE protection.
export const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  processEntities: false,
  parseTagValue: false,
});

/**
 * Decode the five entities XML predefines, and numeric character references.
 *
 * The parser runs with processEntities disabled so a hostile description cannot
 * declare entities of its own — that is the XXE defence and it stays. But the
 * switch is all-or-nothing, so ordinary escaped text came back raw and a router
 * named "OPNsense UPnP IGD &amp; PCP" read back with the escape still in it.
 * The named five expand to plain characters and a numeric reference names its
 * character directly — neither references anything declared, so decoding them
 * afterwards restores the text without reopening anything. Single pass: what a
 * decode produces is never re-decoded.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (match, name: string) => {
    const literal = NAMED_ENTITIES[name];
    if (literal) return literal;
    const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * The SCPD could not be fetched, so support for the action is unknown.
 * Transient: the capability cache clears on failure and the next call asks
 * the router again. Not an UpnpError — no router sent a code.
 */
export class CapabilityUnavailableError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`Cannot verify ${action} support (SCPD unavailable)`);
    this.name = "CapabilityUnavailableError";
    this.action = action;
  }
}

/**
 * The router's own SCPD does not advertise the action. Permanent for this
 * device. Not an UpnpError — no router sent a code.
 */
export class UnsupportedActionError extends Error {
  readonly action: string;
  constructor(action: string) {
    super(`${action} not supported by this device`);
    this.name = "UnsupportedActionError";
    this.action = action;
  }
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

/**
 * Every request asks the router to keep its connection (Connection:
 * keep-alive), and a connection is kept only when the router's answer says
 * keep-alive in so many words. miniupnpd answers close; libupnp answers with
 * no Connection header and closes anyway, so a connection kept on HTTP/1.1's
 * default would be reused after the router had dropped it. A router that does
 * keep it is asked over one connection rather than a new one per request:
 * TP-Link's TPOS and VxWorks routers reset new connections that arrive faster
 * than about one per 6 ms once some 30 have been opened, which a walk of the
 * mapping table does within 50 ms.
 *
 * A kept connection is closed from this side after KEPT_CONNECTION_IDLE_MS
 * unused in the pool: sooner than those routers close one themselves (4 to
 * 5 s), so a request never crosses the router's close, and the connection does
 * not hold one of the router's few slots between unrelated calls. A router
 * that announces a shorter idle time (Keep-Alive: timeout=N) has its connection
 * closed KEEP_ALIVE_HINT_MARGIN_MS before that, and one announcing no more than
 * the margin has none kept. The limit is the pool's alone. Given to the agent
 * as its `timeout` it would apply to every socket from creation, connecting
 * included, and a router slow to accept - a busy miniupnpd, one loop behind a
 * backlog of five - would have requests cut off at the idle limit instead of at
 * their own timeout.
 */
class RouterAgent extends http.Agent {
  private readonly idleLimits = new WeakMap<Socket, number>();

  constructor() {
    super({ keepAlive: true });
    // After the agent's own "free" handler, which sets a pooled socket's
    // timeout to the agent's - none.
    this.on("free", (socket: Socket) => {
      const pooled = Object.values(this.freeSockets).some((sockets) => sockets?.includes(socket));
      if (pooled && !socket.destroyed) socket.setTimeout(this.idleLimits.get(socket) ?? KEPT_CONNECTION_IDLE_MS);
    });
  }

  // Node returns whether the socket was kept; @types/node declares void.
  keepSocketAlive(socket: Socket): void {
    // The request the socket has just carried, and the router's answer to it.
    const res = (socket as any)._httpMessage?.res as http.IncomingMessage | undefined;
    const connection = String(res?.headers.connection ?? "").toLowerCase();
    if (!connection.split(",").some((token) => token.trim() === "keep-alive")) {
      return false as unknown as void;
    }
    const idleLimit = keptIdleLimit(res?.headers["keep-alive"] as string | undefined);
    if (idleLimit <= 0) return false as unknown as void;
    this.idleLimits.set(socket, idleLimit);
    return super.keepSocketAlive(socket);
  }
}
export const KEPT_CONNECTION_IDLE_MS = 3000;
export const KEEP_ALIVE_HINT_MARGIN_MS = 1000;

/**
 * How long a kept connection may sit unused, from the router's Keep-Alive
 * header: KEPT_CONNECTION_IDLE_MS, or less when the router announces a shorter
 * timeout. Zero or less means the connection is not to be kept.
 * @param header the answer's Keep-Alive header, e.g. "timeout=5, max=100"
 */
export function keptIdleLimit(header: string | undefined): number {
  const hint = /(?:^|,)\s*timeout\s*=\s*(\d+)/i.exec(String(header ?? ""))?.[1];
  if (hint === undefined) return KEPT_CONNECTION_IDLE_MS;
  return Math.min(KEPT_CONNECTION_IDLE_MS, Number(hint) * 1000 - KEEP_ALIVE_HINT_MARGIN_MS);
}
/** Exported for the tests, which slow a connection's connect through it. */
export const upnpAgent = new RouterAgent();

// Prevent OOM from malicious/broken router responses
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const axiosDefaults = {
  httpAgent: upnpAgent,
  timeout: 10000,
  maxContentLength: MAX_RESPONSE_BYTES,
  maxBodyLength: MAX_RESPONSE_BYTES,
  maxRedirects: 2,
};

/** How much of a response's end is kept for finding its closing tag. */
const CLOSING_TAG_WINDOW = 256;

/**
 * GET one of the router's XML documents - its device description or a
 * service's SCPD - as text.
 *
 * A response with neither a Content-Length nor chunked encoding ends when the
 * router closes the connection. Some routers send the whole document and then
 * hold the connection open: the AirTies Air4960XR's Broadcom stack (BRCM400)
 * holds it 30 to 35 s, past the request timeout. Such a response is complete
 * once what has arrived ends with the closing tag of `root` and validates as a
 * whole XML document, and the connection is then closed from this side. The
 * validation runs again only once the response has doubled in size since the
 * last, so a response that ends every chunk with that tag costs a bounded
 * number of passes. One that never validates is read until the router closes
 * it, and parsed as it stands.
 *
 * The whole fetch, body included, is bounded by the request timeout and by
 * MAX_RESPONSE_BYTES.
 *
 * `server` is the response's Server header, null when the router sends none.
 */
async function fetchDocument(
  url: string,
  root: string
): Promise<{ text: string; server: string | null }> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`timeout of ${axiosDefaults.timeout}ms exceeded fetching ${url}`)),
    axiosDefaults.timeout
  );
  const closingTag = new RegExp(`</(?:[^\\s<>/:]+:)?${root}\\s*>\\s*$`);
  try {
    const response = await axios.get<Readable>(url, {
      ...axiosDefaults,
      responseType: "stream",
      signal: controller.signal,
    });
    const server = serverHeader(response.headers["server"]);
    const framedByClose =
      response.headers["content-length"] === undefined &&
      !/chunked/i.test(String(response.headers["transfer-encoding"] ?? ""));
    const chunks: Buffer[] = [];
    let size = 0;
    let tail = "";
    let validatedAt = 0;
    // Leaving the loop early destroys the stream, which closes the connection.
    for await (const chunk of response.data as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error(`maxContentLength size of ${MAX_RESPONSE_BYTES} exceeded fetching ${url}`);
      }
      chunks.push(chunk);
      if (!framedByClose) continue;
      tail = (tail + chunk.toString("latin1")).slice(-CLOSING_TAG_WINDOW);
      if (size < 2 * validatedAt || !closingTag.test(tail)) continue;
      validatedAt = size;
      const text = Buffer.concat(chunks).toString("utf8");
      if (XMLValidator.validate(text) === true) return { text, server };
    }
    return { text: Buffer.concat(chunks).toString("utf8"), server };
  } catch (err) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

/** A Server header as a router's software names itself; null when absent or blank. */
function serverHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Options every router request accepts. */
export interface RequestOpts {
  /**
   * Aborting it cancels the request: one not yet sent is never sent, one in
   * flight has its socket closed, and the call rejects with `signal.reason`.
   */
  signal?: AbortSignal;
}

/**
 * Settles with `work`, or rejects with `signal.reason` once the signal aborts.
 * Only this caller's wait ends: `work` may be shared with other callers, so it
 * runs on for them.
 */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Options for a Device. */
export interface DeviceOpts {
  /** The SERVER header of the SSDP answer that announced the device. */
  ssdpServer?: string | null;
}

export class Device implements IDevice {
  readonly description: string;
  readonly services: readonly string[];
  /** The SERVER header of the SSDP answer that announced the device; null when none was given. */
  readonly ssdpServer: string | null;

  // Lazy-init promises — concurrent callers share the same promise.
  // On error, the cache is cleared so subsequent calls retry.
  private descriptionPromise: Promise<{ parsed: Record<string, unknown>; server: string | null }> | null = null;
  private servicePromise: Promise<ResolvedService> | null = null;
  private deviceInfoPromise: Promise<GatewayDevice | null> | null = null;
  private capabilitiesPromise: Promise<ServiceCapabilities | null> | null = null;

  constructor(url: string, options: DeviceOpts = {}) {
    if (!url.startsWith("http")) {
      throw new Error(`Invalid UPnP device URL: ${url}`);
    }
    this.description = url;
    this.ssdpServer = serverHeader(options.ssdpServer);
    // Preference order: v2 first, then v1, then PPP
    this.services = [
      "urn:schemas-upnp-org:service:WANIPConnection:2",
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];
  }

  /**
   * Fetch and parse the root device description XML, with the Server header
   * it was served with. Concurrent calls share one promise. Clears cache on
   * error to allow retry.
   */
  private fetchDescription(): Promise<{ parsed: Record<string, unknown>; server: string | null }> {
    if (!this.descriptionPromise) {
      this.descriptionPromise = fetchDocument(this.description, "root")
        .then(({ text, server }) => ({ parsed: xmlParser.parse(text) as Record<string, unknown>, server }))
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
   * No data is sent on the wire. Asked on every call: the host's address can
   * change while the device stays where it is, and the query costs nothing.
   */
  public getLocalAddress(): Promise<string> {
    const hostname = new URL(this.description).hostname;
    if (!hostname || !net.isIPv4(hostname)) {
      // If hostname is IPv6 or a DNS name, fall back to resolving via the description
      // URL host directly. For IPv6, we'd need a udp6 socket.
      return Promise.resolve("");
    }
    return resolveLocalAddress(hostname).catch(() => "");
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
    const { parsed, server } = await this.fetchDescription();
    const root = (parsed as any)?.root || {};
    const device = root.device || {};
    const { devices } = this.parseDescription({ device });

    const info: GatewayDevice = {
      friendlyName: text(device.friendlyName),
      manufacturer: text(device.manufacturer),
      manufacturerURL: text(device.manufacturerURL),
      modelDescription: text(device.modelDescription),
      modelName: text(device.modelName),
      modelNumber: text(device.modelNumber),
      modelURL: text(device.modelURL),
      serialNumber: text(device.serialNumber),
      UDN: text(device.UDN),
      presentationURL: text(device.presentationURL),
      specVersion: {
        major: Number(root.specVersion?.major) || 0,
        minor: Number(root.specVersion?.minor) || 0,
      },
      configId: root["@_configId"] ? String(root["@_configId"]) : null,
      descriptionURL: this.description,
      ssdpServer: this.ssdpServer,
      httpServer: server,
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

  private async buildCapabilities(): Promise<ServiceCapabilities> {
    const service = await this.resolveService();

    // A fetch failure must reject, not resolve: getCapabilities clears its
    // cache only on rejection, and a swallowed failure here would pin
    // "capabilities unknown" for the life of this Device.
    const { text } = await fetchDocument(service.SCPDURL, "scpd");
    const parsed = xmlParser.parse(text) as Record<string, unknown>;

    const scpd = parsed as any;
    const actionList = scpd?.scpd?.actionList?.action;
    const actions: string[] = [];
    if (Array.isArray(actionList)) {
      for (const a of actionList) {
        const name = fieldValue(a?.name);
        if (name) actions.push(name);
      }
    } else {
      const name = fieldValue(actionList?.name);
      if (name) actions.push(name);
    }

    // A real SCPD always advertises actions. A parseable non-SCPD body — a
    // captive portal, an error page — reaches here with none, and resolving
    // would cache it as a real answer; only rejection routes down the retry
    // path.
    if (actions.length === 0) {
      throw new Error(`Invalid SCPD from ${service.SCPDURL}: no actions`);
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
    const { parsed } = await this.fetchDescription();
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
    args: (string | number)[][],
    options: RequestOpts = {}
  ): Promise<RawResponse> {
    const { signal } = options;
    signal?.throwIfAborted();
    const info = await untilAborted(this.resolveService(), signal);

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

    // No redirects: a control URL that redirects is not one, and without them
    // axios hands back Node's own request, whose reusedSocket the retry below
    // reads.
    const post = () =>
      axios.post(info.controlURL, body, {
        ...axiosDefaults,
        maxRedirects: 0,
        signal,
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          "Content-Length": "" + Buffer.byteLength(body),
          SOAPAction: JSON.stringify(info.service + "#" + action),
        },
      });

    try {
      let response;
      try {
        response = await post();
      } catch (err: unknown) {
        // A kept connection the router has closed fails with no answer at
        // all; the request is sent once more, on a new connection. A new
        // connection that fails is the router's failure and is not.
        const e = err as { response?: unknown; code?: string; request?: { reusedSocket?: boolean } };
        if (signal?.aborted || e.response || !e.request?.reusedSocket || e.code !== "ECONNRESET") throw err;
        response = await post();
      }
      responseData = response.data;
    } catch (err: unknown) {
      if (signal?.aborted) throw signal.reason;
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
  728: "No Port Maps Available",
  729: "Conflict With Other Mechanisms",
  730: "Port Mapping Not Found",
  731: "Read Only",
  732: "Wildcard Not Permitted In Internal Port",
  733: "Inconsistent Parameters",
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
  /** The SERVER header of the SSDP answer that announced the router; null when not discovered or not sent. */
  readonly ssdpServer: string | null;
  /** The Server header the device description was served with; null when not sent. */
  readonly httpServer: string | null;
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
  run(action: string, kvpairs: (string | number)[][], options?: RequestOpts): Promise<RawResponse>;
}
