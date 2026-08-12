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

/**
 * Serve one router's captured responses in place of the network, so the real
 * client and device code runs end to end. Returns a function that restores axios.
 */
export function installFakeRouter(router: string): () => void {
  const realGet = axios.get;
  const realPost = axios.post;

  (axios as any).get = async (url: string) => ({
    data:
      url === DESCRIPTION_URL
        ? loadFixture(`${router}-rootdesc.xml`)
        : loadFixture(`${router}-scpd.xml`),
  });

  (axios as any).post = async (_url: string, body: string, config: any) => {
    const soapAction = String(JSON.parse(config.headers.SOAPAction));
    const action = soapAction.slice(soapAction.indexOf("#") + 1);
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
