import axios from "axios";
import { readFileSync } from "fs";
import { join } from "path";

const fixturesDir = join(__dirname, "..", "..", "test", "fixtures");

export function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

/** Read a fixture if it exists; not every router contributed every response. */
export function tryFixture(name: string): string | null {
  try {
    return readFileSync(join(fixturesDir, name), "utf-8");
  } catch {
    return null;
  }
}

/** Host the fake router answers on. Relative URLs in a fixture resolve against it. */
export const DESCRIPTION_URL = "http://192.0.2.1:5000/rootDesc.xml";

/** External port no fixture has a mapping for, so the router answers NotFound. */
export const UNMAPPED_PORT = 9999;

function isSoapFault(xml: string): boolean {
  return /<(\w+:)?Fault>/.test(xml);
}

function readTag(body: string, tag: string): string {
  const match = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : "";
}

/**
 * Pick the captured response for an action. Several actions have more than one
 * capture, so the request itself selects which one the router would have sent.
 */
function fixtureFor(router: string, action: string, body: string): string {
  switch (action) {
    case "AddPortMapping": {
      const ttl = readTag(body, "NewLeaseDuration") === "0" ? "0" : "60";
      return `${router}-soap-AddPortMapping_TTL${ttl}.xml`;
    }
    case "GetGenericPortMappingEntry":
      // Index 0 holds the captured entry. Past it the router reports
      // end-of-list, which is what terminates the real iteration.
      return readTag(body, "NewPortMappingIndex") === "0"
        ? `${router}-soap-GetGenericPortMappingEntry.xml`
        : `${router}-soap-GetGenericPortMappingEntry_Empty.xml`;
    case "GetSpecificPortMappingEntry":
      return readTag(body, "NewExternalPort") === String(UNMAPPED_PORT)
        ? `${router}-soap-GetSpecificPortMappingEntry_NotFound.xml`
        : `${router}-soap-GetSpecificPortMappingEntry.xml`;
    default:
      return `${router}-soap-${action}.xml`;
  }
}

/** Ways a router can fail that a captured response cannot express. */
export type Breakage =
  | "transport" // socket died mid-request
  | "malformed" // 200 carrying XML that will not parse
  | "empty-500" // HTTP error with no SOAP fault body to unwrap
  | "non-error" // something thrown that is not an Error at all
  | "first-index-401"; // the action itself is refused, from the very first call

/** Every SOAP request the client built during the active install. */
export const requests: { action: string; body: string; headers: Record<string, string> }[] = [];

/**
 * Responses for the three IGD v2 actions.
 *
 * These are SYNTHETIC, built from the IGD:2 service template, not captured from
 * a router. Four fixtures advertise these actions but nobody ever recorded what
 * they answer, so the shapes here are the specified ones and nothing more. They
 * are enough to exercise argument construction, capability gating, the empty
 * cases and the parsing of the documented format — but they are not evidence
 * about how any particular router behaves. Replace them with real captures when
 * the survey brings some back.
 */
function envelope(action: string, inner: string): string {
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:2">` +
    inner +
    `</u:${action}Response></s:Body></s:Envelope>`
  );
}

/** How GetListOfPortMappings answers: an escaped XML document in one element. */
export function portListing(
  entries: { external: number; internal: number; host: string; description: string; ttl: number }[]
): string {
  const body = entries
    .map(
      (e) =>
        "<p:PortMappingEntry>" +
        "<p:NewRemoteHost></p:NewRemoteHost>" +
        `<p:NewExternalPort>${e.external}</p:NewExternalPort>` +
        "<p:NewProtocol>TCP</p:NewProtocol>" +
        `<p:NewInternalPort>${e.internal}</p:NewInternalPort>` +
        `<p:NewInternalClient>${e.host}</p:NewInternalClient>` +
        "<p:NewEnabled>1</p:NewEnabled>" +
        `<p:NewDescription>${e.description}</p:NewDescription>` +
        `<p:NewLeaseTime>${e.ttl}</p:NewLeaseTime>` +
        "</p:PortMappingEntry>"
    )
    .join("");
  return `<p:PortMappingList xmlns:p="urn:schemas-upnp-org:gw:WANIPConnection">${body}</p:PortMappingList>`;
}

/** The three IGD v2 actions, the only ones with synthetic fallbacks. */
const V2_ACTIONS = new Set([
  "AddAnyPortMapping",
  "GetListOfPortMappings",
  "DeletePortMappingRange",
]);

/** True when a test is steering the v2 answers itself. */
function usingV2Overrides(): boolean {
  return v2Escaped || v2Overrides.reservedPort !== undefined || v2Overrides.listing !== undefined;
}

/** Send the listing entity-escaped instead of in CDATA. */
export let v2Escaped = false;
export function setV2Escaped(on: boolean): void {
  v2Escaped = on;
}

/** Overrides the synthetic v2 answers for a single install. */
export let v2Overrides: { reservedPort?: number; listing?: string | null } = {};
export function setV2Overrides(next: typeof v2Overrides): void {
  v2Overrides = next;
}

function v2Response(action: string): string | null {
  switch (action) {
    case "AddAnyPortMapping":
      return envelope(
        "AddAnyPortMapping",
        `<NewReservedPort>${v2Overrides.reservedPort ?? 61000}</NewReservedPort>`
      );
    case "GetListOfPortMappings": {
      if (v2Overrides.listing === null)
        return envelope("GetListOfPortMappings", "<NewPortListing></NewPortListing>");
      const listing =
        v2Overrides.listing ??
        portListing([
          { external: 16137, internal: 16137, host: "192.168.1.50", description: "Flux_A", ttl: 3600 },
          { external: 16147, internal: 9090, host: "192.168.1.51", description: "Flux_B", ttl: 0 },
        ]);
      // Real routers wrap the listing in CDATA -- confirmed against three
      // Ubiquiti gateways. The spec permits entity escaping too, so
      // `escapeListing` covers that variant separately.
      const wrapped = v2Escaped
        ? listing.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : `<![CDATA[${listing}]]>`;
      return envelope("GetListOfPortMappings", `<NewPortListing>${wrapped}</NewPortListing>`);
    }
    case "DeletePortMappingRange":
      return envelope("DeletePortMappingRange", "");
    default:
      return null;
  }
}

/**
 * Serve one router's captured responses in place of the network, so the real
 * client and device code runs end to end. Returns a function that restores axios.
 *
 * `breakage` replaces the SOAP response with a failure a fixture cannot
 * represent, which is the only way into the retry and fault-unwrapping paths.
 */
export function installFakeRouter(router: string, breakage?: Breakage): () => void {
  const realGet = axios.get;
  const realPost = axios.post;
  requests.length = 0;

  (axios as any).get = async (url: string) => ({
    data:
      url === DESCRIPTION_URL
        ? loadFixture(`${router}-rootdesc.xml`)
        : loadFixture(`${router}-scpd.xml`),
  });

  (axios as any).post = async (_url: string, body: string, config: any) => {
    const soapAction = String(JSON.parse(config.headers.SOAPAction));
    const action = soapAction.slice(soapAction.indexOf("#") + 1);
    requests.push({ action, body, headers: config.headers });

    switch (breakage) {
      case "transport":
        throw new Error("socket hang up");
      case "malformed":
        return { data: "<s:Envelope><s:Body><unclosed>" };
      case "empty-500":
        throw { response: { data: "<html>502 Bad Gateway</html>", status: 502 } };
      case "non-error":
        throw "router said no";
      case "first-index-401":
        throw {
          response: {
            data:
              '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
              "<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>" +
              '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
              "<errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription>" +
              "</UPnPError></detail></s:Fault></s:Body></s:Envelope>",
            status: 500,
          },
        };
    }

    // For the v2 actions a captured response always wins: the synthetic shapes
    // exist only for routers the survey could not record, and preferring them
    // would throw away the real data collected from the fleet. Only these three
    // are eligible — every other action picks its file through fixtureFor,
    // which selects by request (index, lease, port) and must not be bypassed.
    if (V2_ACTIONS.has(action) && !usingV2Overrides()) {
      const captured = tryFixture(`${router}-soap-${action}.xml`);
      if (captured) return { data: captured };
    }
    const synthetic = v2Response(action);
    if (synthetic) return { data: synthetic };

    const xml = loadFixture(fixtureFor(router, action, body));
    // A fault arrives as an HTTP error carrying the fault body, the shape the
    // device code unwraps to recover the UPnP error code.
    if (isSoapFault(xml)) throw { response: { data: xml, status: 500 } };
    return { data: xml };
  };

  return () => {
    (axios as any).get = realGet;
    (axios as any).post = realPost;
  };
}
