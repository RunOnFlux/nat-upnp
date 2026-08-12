import axios from "axios";
import { readFileSync } from "fs";
import { join } from "path";

const fixturesDir = join(__dirname, "..", "..", "test", "fixtures");

export function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
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
