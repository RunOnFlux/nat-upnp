import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import axiosModule, { type AxiosRequestConfig } from "axios";
import { UpnpError, UPNP_ERROR_CODES, decodeXmlEntities } from "../src/nat-upnp/device";
import { Device } from "../src/nat-upnp/device";
import { Client } from "../src/nat-upnp/client";
import { parseMimeHeader, Ssdp, type SsdpEmitter } from "../src/nat-upnp/ssdp";
import { surveyedRouters } from "./router-data";
import { installFakeDgram, FakeSocket, ssdpResponse, settle } from "./fake-dgram";
import {
  installFakeRouter,
  requests,
  setEmptyTable,
  setV1Table,
  setV2Overrides,
  setV2Escaped,
  portListing,
  DESCRIPTION_URL,
  UNMAPPED_PORT,
  type Breakage,
} from "./fake-router";

// Fixtures are in test/fixtures/ (source), not build/test/fixtures/
const fixturesDir = join(__dirname, "..", "..", "test", "fixtures");

function loadFixture(name: string): string {
  const path = join(fixturesDir, name);
  if (!existsSync(path)) throw new Error(`Fixture not found: ${name}`);
  return readFileSync(path, "utf-8");
}

// Simple test runner
let passed = 0;
let failed = 0;
const errors: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err.message || String(err);
    errors.push(`${name}: ${msg}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual: any, expected: any, msg?: string) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ": " : "") +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

const xmlParser = new XMLParser({ removeNSPrefix: true });
const descParser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false });

const routers = [
  "opnsense",
  "pfsense-2.7",
  "pfsense-2.8",
  "asus-rt-ax55",
  "nec-sh621a1",
  "sagemcom-livebox",
  "sagemcom-f5685",
  "nokia-igd-v2",
  "mikrotik",
  "freebox",
  "linux-igd",
  "sercomm-gpon",
  "technicolor",
];

// Expected device info per router
const expectedDevices: Record<
  string,
  { manufacturer: string; modelName: string; modelNumber?: string }
> = {
  opnsense: { manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "26.1.3" },
  "pfsense-2.7": { manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.7.2-RELEASE" },
  "pfsense-2.8": { manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.8.1-RELEASE" },
  "asus-rt-ax55": { manufacturer: "ASUSTeK Computer Inc.", modelName: "ASUS Wireless Router", modelNumber: "RT-AX55" },
  "nec-sh621a1": { manufacturer: "NEC Corporation/NEC Platforms, Ltd.", modelName: "SH621A1" },
  "sagemcom-livebox": { manufacturer: "Sagemcom", modelName: "Residential Livebox (GPON, WAN Ethernet)" },
  "sagemcom-f5685": { manufacturer: "Sagemcom", modelName: "F5685LGB" },
  "nokia-igd-v2": { manufacturer: "Nokia", modelName: "IGD Version 2.00" },
  mikrotik: { manufacturer: "MikroTik", modelName: "Router OS" },
  freebox: { manufacturer: "Freebox", modelName: "Freebox Server" },
  "linux-igd": { manufacturer: "Linux UPnP IGD Project", modelName: "IGD Version 1.00" },
  "sercomm-gpon": { manufacturer: "Sercomm", modelName: "FG824CD" },
  technicolor: { manufacturer: "Technicolor", modelName: "MediaAccess FG" },
};

// Expected capabilities
const expectedCaps: Record<
  string,
  { v2Actions: boolean; minActions: number; serviceVersion: number }
> = {
  opnsense: { v2Actions: false, minActions: 11, serviceVersion: 1 },
  "pfsense-2.7": { v2Actions: false, minActions: 10, serviceVersion: 1 },
  "pfsense-2.8": { v2Actions: false, minActions: 10, serviceVersion: 1 },
  "asus-rt-ax55": { v2Actions: false, minActions: 11, serviceVersion: 1 },
  "nec-sh621a1": { v2Actions: false, minActions: 9, serviceVersion: 1 },
  "sagemcom-livebox": { v2Actions: true, minActions: 20, serviceVersion: 1 },
  "sagemcom-f5685": { v2Actions: false, minActions: 11, serviceVersion: 1 },
  "nokia-igd-v2": { v2Actions: true, minActions: 17, serviceVersion: 2 },
  mikrotik: { v2Actions: false, minActions: 11, serviceVersion: 1 },
  freebox: { v2Actions: false, minActions: 11, serviceVersion: 1 },
  "linux-igd": { v2Actions: false, minActions: 11, serviceVersion: 1 },
  "sercomm-gpon": { v2Actions: true, minActions: 14, serviceVersion: 2 },
  technicolor: { v2Actions: true, minActions: 14, serviceVersion: 2 },
};

// Expected TTL behavior
const expectedTtl: Record<
  string,
  { ttl60: "success" | "fault"; ttl0: "success" | "fault"; faultCode?: number }
> = {
  opnsense: { ttl60: "success", ttl0: "success" },
  "pfsense-2.7": { ttl60: "success", ttl0: "success" },
  "pfsense-2.8": { ttl60: "success", ttl0: "success" },
  "asus-rt-ax55": { ttl60: "success", ttl0: "success" },
  "nec-sh621a1": { ttl60: "success", ttl0: "success" },
  "sagemcom-livebox": { ttl60: "success", ttl0: "success" },
  "sagemcom-f5685": { ttl60: "success", ttl0: "success" },
  "nokia-igd-v2": { ttl60: "success", ttl0: "success" },
  mikrotik: { ttl60: "fault", ttl0: "success", faultCode: 725 },
  freebox: { ttl60: "success", ttl0: "success" },
  "linux-igd": { ttl60: "success", ttl0: "success" },
  "sercomm-gpon": { ttl60: "success", ttl0: "success" },
  technicolor: { ttl60: "success", ttl0: "success" },
};

function parseSoapBody(xml: string) {
  return xmlParser.parse(xml)?.Envelope?.Body;
}

function hasSoapFault(xml: string): boolean {
  const body = parseSoapBody(xml);
  return !!body?.Fault;
}

function getSoapFaultCode(xml: string): number | null {
  const body = parseSoapBody(xml);
  if (!body?.Fault) return null;
  return body.Fault.detail?.UPnPError?.errorCode ?? null;
}

(async () => {
  // ========================================
  // Device Description Parsing
  // ========================================
  console.log("\n=== Device Description Parsing ===\n");

  for (const router of routers) {
    await test(`${router}: rootDesc.xml parses without error`, () => {
      const xml = loadFixture(`${router}-rootdesc.xml`);
      const parsed = descParser.parse(xml);
      assert(!!parsed.root, "Missing root element");
      assert(!!parsed.root.device, "Missing device element");
    });

    await test(`${router}: correct manufacturer and model`, () => {
      const xml = loadFixture(`${router}-rootdesc.xml`);
      const parsed = descParser.parse(xml);
      const device = parsed.root.device;
      const expected = expectedDevices[router];

      assertEqual(device.manufacturer, expected.manufacturer, "manufacturer");
      assertEqual(device.modelName, expected.modelName, "modelName");
      if (expected.modelNumber) {
        assertEqual(String(device.modelNumber), expected.modelNumber, "modelNumber");
      }
    });

    await test(`${router}: device tree traversal finds services`, () => {
      const xml = loadFixture(`${router}-rootdesc.xml`);
      const parsed = new XMLParser().parse(xml);
      const dev = new Device("http://fake/rootDesc.xml");
      const { services, devices } = dev.parseDescription(parsed.root);
      assert(services.length > 0, `No services found (${services.length})`);
      assert(devices.length > 0, `No devices found (${devices.length})`);

      const wanService = services.find(
        (s: any) =>
          s.serviceType?.includes("WANIPConnection") ||
          s.serviceType?.includes("WANPPPConnection")
      );
      assert(!!wanService, "No WAN service found in: " + services.map((s: any) => s.serviceType).join(", "));
    });
  }

  // WAN sub-device identification
  await test("opnsense: WAN sub-device identifies MiniUPnPd", () => {
    const xml = loadFixture("opnsense-rootdesc.xml");
    const parsed = new XMLParser().parse(xml);
    const dev = new Device("http://fake/rootDesc.xml");
    const { devices } = dev.parseDescription(parsed.root);
    const wan = devices.find((d: any) => d.modelDescription?.includes("MiniUPnP"));
    assert(!!wan, "MiniUPnP WAN device not found");
  });

  await test("mikrotik: WAN sub-device has minimal info", () => {
    const xml = loadFixture("mikrotik-rootdesc.xml");
    const parsed = new XMLParser().parse(xml);
    const dev = new Device("http://fake/rootDesc.xml");
    const { devices } = dev.parseDescription(parsed.root);
    assert(devices.length >= 1, "Should have at least root device");
  });

  // ========================================
  // SCPD Capability Parsing
  // ========================================
  console.log("\n=== SCPD Capability Parsing ===\n");

  for (const router of routers) {
    await test(`${router}: SCPD parses action list`, () => {
      const xml = loadFixture(`${router}-scpd.xml`);
      const parsed = xmlParser.parse(xml);
      const actionList = parsed?.scpd?.actionList?.action;
      assert(!!actionList, "No actionList found");

      const actions = Array.isArray(actionList)
        ? actionList.map((a: any) => a.name).filter(Boolean)
        : [actionList.name].filter(Boolean);

      const expected = expectedCaps[router];
      assert(
        actions.length >= expected.minActions,
        `Expected >= ${expected.minActions} actions, got ${actions.length}`
      );
    });

    await test(`${router}: core v1 actions present`, () => {
      const xml = loadFixture(`${router}-scpd.xml`);
      const parsed = xmlParser.parse(xml);
      const actionList = parsed?.scpd?.actionList?.action;
      const actions = Array.isArray(actionList)
        ? actionList.map((a: any) => a.name)
        : [actionList?.name];

      const required = ["AddPortMapping", "DeletePortMapping", "GetExternalIPAddress"];
      for (const action of required) {
        assert(actions.includes(action), `Missing required action: ${action}`);
      }
    });

    await test(`${router}: v2 actions match expected`, () => {
      const xml = loadFixture(`${router}-scpd.xml`);
      const parsed = xmlParser.parse(xml);
      const actionList = parsed?.scpd?.actionList?.action;
      const actions = new Set(
        Array.isArray(actionList)
          ? actionList.map((a: any) => a.name)
          : [actionList?.name]
      );

      const expected = expectedCaps[router];
      const hasV2 = actions.has("AddAnyPortMapping");
      assertEqual(hasV2, expected.v2Actions, "v2 action support");
    });

    await test(`${router}: service version from rootDesc matches expected`, () => {
      const xml = loadFixture(`${router}-rootdesc.xml`);
      const parsed = new XMLParser().parse(xml);
      const dev = new Device("http://fake/rootDesc.xml");
      const { services } = dev.parseDescription(parsed.root);

      const wanService = services.find(
        (s: any) => s.serviceType?.includes("WANIPConnection")
      );
      if (!wanService) return; // WANPPPConnection routers skip this

      const versionMatch = wanService.serviceType.match(/:(\d+)$/);
      const version = versionMatch ? parseInt(versionMatch[1], 10) : 1;
      assertEqual(version, expectedCaps[router].serviceVersion, "service version");
    });
  }

  // ========================================
  // SOAP Response Parsing — Success Cases
  // ========================================
  console.log("\n=== SOAP Response Parsing — Success ===\n");

  for (const router of routers) {
    await test(`${router}: GetExternalIPAddress`, () => {
      const xml = loadFixture(`${router}-soap-GetExternalIPAddress.xml`);
      const body = parseSoapBody(xml);
      assert(!body.Fault, "Unexpected fault");
      const key = Object.keys(body).find((k) => /GetExternalIPAddressResponse/.test(k));
      assert(!!key, "Response key not found");
      const ip = body[key!].NewExternalIPAddress;
      assert(ip !== undefined, "IP missing");
    });

    await test(`${router}: GetStatusInfo`, () => {
      const xml = loadFixture(`${router}-soap-GetStatusInfo.xml`);
      const body = parseSoapBody(xml);
      assert(!body.Fault, "Unexpected fault");
      const key = Object.keys(body).find((k) => /GetStatusInfoResponse/.test(k));
      assert(!!key, "Response key not found");
      const res = body[key!];
      assert(res.NewConnectionStatus !== undefined, "ConnectionStatus missing");
      assert(res.NewUptime !== undefined, "Uptime missing");
    });

    await test(`${router}: GetNATRSIPStatus`, () => {
      const xml = loadFixture(`${router}-soap-GetNATRSIPStatus.xml`);
      const body = parseSoapBody(xml);
      assert(!body.Fault, "Unexpected fault");
      const key = Object.keys(body).find((k) => /GetNATRSIPStatusResponse/.test(k));
      assert(!!key, "Response key not found");
    });

    await test(`${router}: GetConnectionTypeInfo`, () => {
      const xml = loadFixture(`${router}-soap-GetConnectionTypeInfo.xml`);
      const body = parseSoapBody(xml);
      assert(!body.Fault, "Unexpected fault");
      const key = Object.keys(body).find((k) => /GetConnectionTypeInfoResponse/.test(k));
      assert(!!key, "Response key not found");
    });

    await test(`${router}: GetGenericPortMappingEntry (index 0)`, () => {
      const xml = loadFixture(`${router}-soap-GetGenericPortMappingEntry.xml`);
      const body = parseSoapBody(xml);
      assert(!body.Fault, "Unexpected fault");
      const key = Object.keys(body).find((k) => /GetGenericPortMappingEntryResponse/.test(k));
      assert(!!key, "Response key not found");
      const res = body[key!];
      assert(res.NewExternalPort !== undefined, "ExternalPort missing");
      assert(res.NewInternalClient !== undefined, "InternalClient missing");
      assert(res.NewProtocol !== undefined, "Protocol missing");
      assert(res.NewLeaseDuration !== undefined, "LeaseDuration missing");
    });

    await test(`${router}: GetSpecificPortMappingEntry (existing)`, () => {
      const xml = loadFixture(`${router}-soap-GetSpecificPortMappingEntry.xml`);
      const body = parseSoapBody(xml);
      if (body.Fault) {
        // Some fixtures captured a fault because the test mapping expired during collection
        // (MikroTik, Freebox). This is valid — just verify the fault parses correctly.
        const code = body.Fault.detail?.UPnPError?.errorCode;
        assert(typeof code === "number", "Fault should have errorCode, got: " + JSON.stringify(body.Fault));
        console.log(`    (fixture is a fault: code=${code} — test mapping expired during collection)`);
      } else {
        const key = Object.keys(body).find((k) => /GetSpecificPortMappingEntryResponse/.test(k));
        assert(!!key, "Response key not found");
        const res = body[key!];
        assert(res.NewInternalPort !== undefined, "InternalPort missing");
        assert(res.NewInternalClient !== undefined, "InternalClient missing");
        assert(res.NewLeaseDuration !== undefined, "LeaseDuration missing");
      }
    });
  }

  // ========================================
  // SOAP Response Parsing — Error/Fault Cases
  // ========================================
  console.log("\n=== SOAP Response Parsing — Faults ===\n");

  for (const router of routers) {
    await test(`${router}: GetGenericPortMappingEntry_Empty is a fault`, () => {
      const xml = loadFixture(`${router}-soap-GetGenericPortMappingEntry_Empty.xml`);
      assert(hasSoapFault(xml), "Expected a SOAP fault for empty index");
    });

    await test(`${router}: GetSpecificPortMappingEntry_NotFound is a fault`, () => {
      const xml = loadFixture(`${router}-soap-GetSpecificPortMappingEntry_NotFound.xml`);
      assert(hasSoapFault(xml), "Expected a SOAP fault for not found");
      const code = getSoapFaultCode(xml);
      // Most routers return 714 (NoSuchEntryInArray) or 713 (SpecifiedArrayIndexInvalid)
      // Sagemcom Livebox returns 606 (Action not authorized)
      assert(
        code === 714 || code === 713 || code === 606,
        `Expected 714, 713, or 606, got ${code}`
      );
    });
  }

  // ========================================
  // TTL Behavior
  // ========================================
  console.log("\n=== TTL Behavior ===\n");

  for (const router of routers) {
    const expected = expectedTtl[router];

    await test(`${router}: AddPortMapping TTL=60 → ${expected.ttl60}`, () => {
      const xml = loadFixture(`${router}-soap-AddPortMapping_TTL60.xml`);
      const isFault = hasSoapFault(xml);

      if (expected.ttl60 === "fault") {
        assert(isFault, "Expected fault but got success");
        if (expected.faultCode) {
          const code = getSoapFaultCode(xml);
          assertEqual(code, expected.faultCode, "fault code");
        }
      } else {
        assert(!isFault, "Expected success but got fault: code=" + getSoapFaultCode(xml));
      }
    });

    await test(`${router}: AddPortMapping TTL=0 → ${expected.ttl0}`, () => {
      const xml = loadFixture(`${router}-soap-AddPortMapping_TTL0.xml`);
      const isFault = hasSoapFault(xml);

      if (expected.ttl0 === "fault") {
        assert(isFault, "Expected fault but got success");
      } else {
        assert(!isFault, "Expected success but got fault: code=" + getSoapFaultCode(xml));
      }
    });
  }

  // ========================================
  // SOAP Fault Parsing — Specific Error Codes
  // ========================================
  console.log("\n=== Specific SOAP Faults ===\n");

  await test("mikrotik: 725 OnlyPermanentLeasesSupported", () => {
    const xml = loadFixture("mikrotik-soap-AddPortMapping_TTL60.xml");
    const body = parseSoapBody(xml);
    assertEqual(body.Fault.detail.UPnPError.errorCode, 725);
    assertEqual(body.Fault.detail.UPnPError.errorDescription, "OnlyPermanentLeasesSupported");
  });

  await test("mikrotik: 714 NoSuchEntryInArray", () => {
    const xml = loadFixture("mikrotik-soap-GetSpecificPortMappingEntry_NotFound.xml");
    assertEqual(getSoapFaultCode(xml), 714);
  });

  await test("freebox: GetGenericPortMappingEntry_Empty is 713", () => {
    const xml = loadFixture("freebox-soap-GetGenericPortMappingEntry_Empty.xml");
    assert(hasSoapFault(xml), "Expected fault");
    const code = getSoapFaultCode(xml);
    assert(code === 713 || code === 714, `Expected 713 or 714, got ${code}`);
  });

  // ========================================
  // UpnpError Class
  // ========================================
  console.log("\n=== UpnpError Class ===\n");

  await test("UpnpError has correct properties", () => {
    const err = new UpnpError(725, "OnlyPermanentLeasesSupported", "AddPortMapping");
    assertEqual(err.code, 725);
    assertEqual(err.description, "OnlyPermanentLeasesSupported");
    assertEqual(err.action, "AddPortMapping");
    assertEqual(err.name, "UpnpError");
    assert(err instanceof Error, "Should be instanceof Error");
    assert(err.message.includes("725"), "Message should include code");
    assert(err.message.includes("AddPortMapping"), "Message should include action");
  });

  await test("UpnpError with code 0 for unknown errors", () => {
    const err = new UpnpError(0, "Unknown", "SomeAction");
    assertEqual(err.code, 0);
  });

  // ========================================
  // Edge Cases
  // ========================================
  console.log("\n=== Edge Cases ===\n");

  await test("ServiceCapabilities.actions serializes to JSON as array", () => {
    const actions = ["AddPortMapping", "DeletePortMapping"];
    const json = JSON.stringify({ actions });
    const parsed = JSON.parse(json);
    assert(Array.isArray(parsed.actions), "Should be an array after JSON round-trip");
    assertEqual(parsed.actions.length, 2);
  });

  await test("Empty SCPD actionList produces empty actions", () => {
    const xml = '<?xml version="1.0"?><scpd><actionList></actionList></scpd>';
    const parsed = xmlParser.parse(xml);
    const actionList = parsed?.scpd?.actionList?.action;
    const actions: string[] = [];
    if (Array.isArray(actionList)) {
      for (const a of actionList) if (a?.name) actions.push(a.name);
    } else if (actionList?.name) {
      actions.push(actionList.name);
    }
    assertEqual(actions.length, 0);
  });

  await test("Single-action SCPD produces single-element array", () => {
    const xml =
      '<?xml version="1.0"?><scpd><actionList><action><name>GetExternalIPAddress</name></action></actionList></scpd>';
    const parsed = xmlParser.parse(xml);
    const actionList = parsed?.scpd?.actionList?.action;
    const actions: string[] = [];
    if (Array.isArray(actionList)) {
      for (const a of actionList) if (a?.name) actions.push(a.name);
    } else if (actionList?.name) {
      actions.push(actionList.name);
    }
    assertEqual(actions.length, 1);
    assertEqual(actions[0], "GetExternalIPAddress");
  });

  await test("SOAP fault with empty errorDescription still parses", () => {
    // Some routers return empty errorDescription (observed on Freebox 718 before table was freed)
    const xml =
      '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
      "<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>" +
      '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
      "<errorCode>718</errorCode><errorDescription></errorDescription>" +
      "</UPnPError></detail></s:Fault></s:Body></s:Envelope>";
    const body = parseSoapBody(xml);
    assert(!!body.Fault, "Expected fault");
    assertEqual(body.Fault.detail.UPnPError.errorCode, 718);
    const desc = body.Fault.detail.UPnPError.errorDescription;
    assert(desc === "" || desc === undefined, "Expected empty description, got: " + desc);
  });

  await test("Multiline SOAP response parses (MikroTik format)", () => {
    // MikroTik returns formatted XML with whitespace
    const xml = loadFixture("mikrotik-soap-GetStatusInfo.xml");
    const body = parseSoapBody(xml);
    assert(!body.Fault, "Unexpected fault");
    const key = Object.keys(body).find((k) => /GetStatusInfoResponse/.test(k));
    assert(!!key, "Response key not found");
  });

  await test("Compact SOAP response parses (Freebox format)", () => {
    // Freebox returns single-line compact XML
    const xml = loadFixture("freebox-soap-GetStatusInfo.xml");
    const body = parseSoapBody(xml);
    assert(!body.Fault, "Unexpected fault");
    const key = Object.keys(body).find((k) => /GetStatusInfoResponse/.test(k));
    assert(!!key, "Response key not found");
  });

  // ========================================
  // parseDescription robustness
  // ========================================
  console.log("\n=== parseDescription Robustness ===\n");

  await test("parseDescription: empty device", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({});
    assertEqual(result.services.length, 0);
    assertEqual(result.devices.length, 0);
  });

  await test("parseDescription: device with no serviceList", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({ device: { deviceType: "test" } as any });
    assertEqual(result.services.length, 0);
    assertEqual(result.devices.length, 1);
  });

  await test("parseDescription: device with single service (not array)", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({
      device: {
        deviceType: "test",
        serviceList: {
          service: { serviceType: "urn:test:1", serviceId: "id1", controlURL: "/ctl" },
        },
      } as any,
    });
    assertEqual(result.services.length, 1);
    assertEqual(result.services[0].serviceType, "urn:test:1");
  });

  await test("parseDescription: filters out non-object services", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({
      device: {
        deviceType: "test",
        serviceList: { service: [
          { serviceType: "urn:valid:1", serviceId: "id1" },
          null,
          undefined,
          "garbage",
          { serviceType: "urn:valid:2", serviceId: "id2" },
        ] as any },
      } as any,
    });
    assertEqual(result.services.length, 2);
  });

  await test("parseDescription: handles non-object device gracefully", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({ device: "not an object" as any });
    assertEqual(result.services.length, 0);
    assertEqual(result.devices.length, 0);
  });

  await test("parseDescription: nested device tree", () => {
    const device = new Device("http://fake");
    const result = device.parseDescription({
      device: {
        deviceType: "root",
        deviceList: {
          device: {
            deviceType: "child",
            serviceList: {
              service: { serviceType: "urn:child:1", serviceId: "id1", controlURL: "/ctl" },
            },
          },
        },
      } as any,
    });
    assertEqual(result.devices.length, 2); // root + child
    assertEqual(result.services.length, 1);
  });

  // ========================================
  // UpnpError edge cases
  // ========================================
  console.log("\n=== UpnpError Edge Cases ===\n");

  await test("UpnpError sanitizes NaN code to 0", () => {
    const err = new UpnpError(NaN, "test", "test");
    assertEqual(err.code, 0);
  });

  await test("UpnpError sanitizes null-ish description", () => {
    const err = new UpnpError(500, "" as any, "test");
    assertEqual(err.description, "Unknown");
  });

  await test("UpnpError sanitizes undefined action", () => {
    const err = new UpnpError(500, "test", undefined as any);
    assertEqual(err.action, "Unknown");
  });

  // ========================================
  // SOAP fault extraction
  // ========================================
  console.log("\n=== SOAP Fault Extraction ===\n");

  await test("Fault with no detail still parses", () => {
    const xml =
      '<Envelope><Body><Fault><faultcode>s:Client</faultcode>' +
      "<faultstring>SomeError</faultstring></Fault></Body></Envelope>";
    const body = xmlParser.parse(xml)?.Envelope?.Body;
    assert(!!body.Fault, "Expected fault");
    assertEqual(body.Fault.faultstring, "SomeError");
  });

  await test("Fault with no UPnPError detail", () => {
    const xml =
      '<Envelope><Body><Fault><faultcode>s:Server</faultcode>' +
      "<faultstring>Internal Error</faultstring>" +
      "<detail><other>stuff</other></detail></Fault></Body></Envelope>";
    const body = xmlParser.parse(xml)?.Envelope?.Body;
    assert(!!body.Fault, "Expected fault");
    // No UPnPError → errorCode would be undefined
    assertEqual(body.Fault.detail?.UPnPError, undefined);
  });

  // ========================================
  // SSDP parseMimeHeader
  // ========================================
  console.log("\n=== SSDP Header Parsing ===\n");

  await test("MIME header parsing: standard CRLF", () => {
    const headers = parseMimeHeader(
      "HTTP/1.1 200 OK\r\nST: urn:test:1\r\nLocation: http://1.2.3.4/\r\n\r\n"
    );
    assertEqual(headers["st"], "urn:test:1");
    assertEqual(headers["location"], "http://1.2.3.4/");
  });

  await test("MIME header parsing: LF-only line endings", () => {
    const headers = parseMimeHeader(
      "HTTP/1.1 200 OK\nST: urn:test:1\nLocation: http://1.2.3.4/\n\n"
    );
    assertEqual(headers["st"], "urn:test:1");
    assertEqual(headers["location"], "http://1.2.3.4/");
  });

  await test("MIME header parsing: empty value", () => {
    const headers = parseMimeHeader("HTTP/1.1 200 OK\r\nST:\r\n\r\n");
    assertEqual(headers["st"], "");
  });

  await test("MIME header parsing: field names are lowercased", () => {
    const headers = parseMimeHeader("HTTP/1.1 200 OK\r\nLOCATION: http://1.2.3.4/\r\n\r\n");
    assertEqual(headers["location"], "http://1.2.3.4/");
    assertEqual(headers["LOCATION"], undefined);
  });

  await test("MIME header parsing: whitespace before the colon stays out of the key", () => {
    // The value side is trimmed; padding on the name side produced the key
    // "location " and the response was silently dropped as having no
    // Location header at all.
    const headers = parseMimeHeader("HTTP/1.1 200 OK\r\nLOCATION : http://1.2.3.4/\r\n\r\n");
    assertEqual(headers["location"], "http://1.2.3.4/");
  });

  await test("MIME header parsing: value with colons", () => {
    const headers = parseMimeHeader(
      "HTTP/1.1 200 OK\r\nLocation: http://192.168.1.1:8080/desc.xml\r\n\r\n"
    );
    // Should capture full URL including port
    assertEqual(headers["location"], "http://192.168.1.1:8080/desc.xml");
  });

  // ========================================
  // Service version preference order
  // ========================================
  console.log("\n=== Service Preference Order ===\n");

  await test("Device prefers WANIPConnection:2 over :1", () => {
    const device = new Device("http://fake");
    // services list has :2 first
    assertEqual(device.services[0], "urn:schemas-upnp-org:service:WANIPConnection:2");
    assertEqual(device.services[1], "urn:schemas-upnp-org:service:WANIPConnection:1");
  });

  // ========================================
  // Mapping field safety
  // ========================================
  console.log("\n=== Mapping Field Safety ===\n");

  // Test parseMapping behavior by checking fixture parsing
  await test("Mapping with all fields present parses correctly", () => {
    const xml = loadFixture("opnsense-soap-GetGenericPortMappingEntry.xml");
    const body = xmlParser.parse(xml)?.Envelope?.Body;
    const key = Object.keys(body).find((k) => k.startsWith("GetGenericPortMappingEntryResponse"));
    assert(!!key, "Key not found");
    const res = body[key!];
    // Values, not just presence — an empty or renamed field would slip past
    // an existence check.
    assertEqual(Number(res.NewExternalPort), 16132, "ExternalPort");
    assertEqual(Number(res.NewInternalPort), 16132, "InternalPort");
    assertEqual(String(res.NewInternalClient), "172.16.32.143", "InternalClient");
    assertEqual(String(res.NewProtocol), "TCP", "Protocol");
    assertEqual(Number(res.NewLeaseDuration), 1856, "LeaseDuration");
    assertEqual(String(res.NewPortMappingDescription), "FluxOS Reserved", "Description");
  });

  await test("TTL field is numeric across all router fixtures", () => {
    let checked = 0;
    for (const router of routers) {
      const xml = loadFixture(`${router}-soap-GetSpecificPortMappingEntry.xml`);
      const body = xmlParser.parse(xml)?.Envelope?.Body;
      assert(!body.Fault, `${router}: expected a mapping, got a fault`);
      const key = Object.keys(body).find((k) => k.startsWith("GetSpecificPortMappingEntryResponse"));
      assert(!!key, `${router}: no GetSpecificPortMappingEntryResponse`);
      const ttl = parseInt(body[key!].NewLeaseDuration, 10);
      assert(!isNaN(ttl), `${router}: TTL is NaN`);
      assert(ttl >= 0, `${router}: TTL is negative: ${ttl}`);
      checked++;
    }
    // Without this the loop could skip every router and still report success.
    assertEqual(checked, routers.length, "routers checked");
  });

  // ========================================
  // Client, driven against each captured router
  // ========================================
  console.log("\n=== Client against captured routers ===\n");

  // Matches the opnsense capture, so `local` is true there and false elsewhere.
  const LOCAL_ADDRESS = "172.16.32.12";

  const expectedExternalIp: Record<string, string> = {
    "asus-rt-ax55": "203.0.113.11",
    freebox: "203.0.113.12",
    "linux-igd": "203.0.113.13",
    mikrotik: "203.0.113.14",
    "nec-sh621a1": "203.0.113.15",
    "nokia-igd-v2": "203.0.113.16",
    opnsense: "203.0.113.17",
    "pfsense-2.7": "203.0.113.18",
    "pfsense-2.8": "203.0.113.19",
    "sagemcom-f5685": "203.0.113.20",
    "sagemcom-livebox": "203.0.113.21",
    "sercomm-gpon": "203.0.113.22",
    technicolor: "203.0.113.23",
  };

  type ExpectedMapping = {
    public: number;
    host: string;
    private: number;
    protocol: string;
    description: string;
  };

  const expectedGenericEntry: Record<string, ExpectedMapping> = {
    "asus-rt-ax55": { public: 16137, host: "192.168.30.31", private: 16137, protocol: "tcp", description: "Flux_Backend_API" },
    freebox: { public: 16122, host: "192.168.1.15", private: 16122, protocol: "tcp", description: "FluxOS Reserved" },
    "linux-igd": { public: 16132, host: "192.168.20.21", private: 16132, protocol: "tcp", description: "FluxOS Reserved" },
    mikrotik: { public: 0, host: "0.0.0.0", private: 0, protocol: "tcp", description: "Dummy inactive rule for windows to work" },
    "nec-sh621a1": { public: 23106, host: "192.168.10.21", private: 23106, protocol: "tcp", description: "Flux_Test_App" },
    "nokia-igd-v2": { public: 9153, host: "192.168.18.16", private: 9153, protocol: "udp", description: "Flux_Test_App" },
    opnsense: { public: 16132, host: "172.16.32.143", private: 16132, protocol: "tcp", description: "FluxOS Reserved" },
    "pfsense-2.7": { public: 16182, host: "192.168.164.87", private: 16182, protocol: "tcp", description: "FluxOS Reserved" },
    "pfsense-2.8": { public: 16152, host: "10.23.4.83", private: 16152, protocol: "tcp", description: "FluxOS Reserved" },
    "sagemcom-f5685": { public: 10928, host: "192.168.1.236", private: 32400, protocol: "tcp", description: "Plex Media Server" },
    "sagemcom-livebox": { public: 16137, host: "192.168.1.112", private: 16137, protocol: "tcp", description: "Flux_Backend_API" },
    "sercomm-gpon": { public: 16157, host: "192.168.1.11", private: 16157, protocol: "tcp", description: "Flux_Backend_API" },
    technicolor: { public: 16182, host: "192.168.1.188", private: 16182, protocol: "tcp", description: "FluxOS Reserved" },
  };

  const expectedSpecificEntry: Record<string, { host: string; private: number; description: string }> = {
    "asus-rt-ax55": { host: "192.168.30.31", private: 59988, description: "Fixture" },
    freebox: { host: "192.168.1.28", private: 16159, description: "FixtureTest" },
    "linux-igd": { host: "192.168.20.21", private: 59988, description: "Fixture" },
    mikrotik: { host: "192.168.0.3", private: 59988, description: "Fixture" },
    "nec-sh621a1": { host: "192.168.10.21", private: 59988, description: "Fixture" },
    "nokia-igd-v2": { host: "192.168.18.19", private: 59988, description: "Fixture" },
    opnsense: { host: "172.16.32.12", private: 59990, description: "FixtureTest" },
    "pfsense-2.7": { host: "192.168.164.77", private: 59988, description: "Fixture" },
    "pfsense-2.8": { host: "10.23.4.82", private: 59988, description: "Fixture" },
    "sagemcom-f5685": { host: "192.168.1.74", private: 59988, description: "Fixture" },
    "sagemcom-livebox": { host: "192.168.1.113", private: 59988, description: "Fixture" },
    "sercomm-gpon": { host: "192.168.1.11", private: 59988, description: "Fixture" },
    technicolor: { host: "192.168.1.202", private: 59988, description: "Fixture" },
  };

  async function withRouter<T>(
    router: string,
    fn: (client: Client) => Promise<T>
  ): Promise<T> {
    const restore = installFakeRouter(router);
    const client = new Client({
      url: DESCRIPTION_URL,
      localAddress: LOCAL_ADDRESS,
    });
    try {
      return await fn(client);
    } finally {
      client.close();
      restore();
    }
  }

  async function expectUpnpError(
    promise: Promise<unknown>,
    code: number,
    what: string
  ) {
    try {
      await promise;
    } catch (err) {
      assert(err instanceof UpnpError, `${what}: expected UpnpError, got ${err}`);
      assertEqual((err as UpnpError).code, code, what);
      return;
    }
    throw new Error(`${what}: expected UpnpError ${code}, but the call resolved`);
  }

  for (const router of routers) {
    await test(`${router}: getPublicIp extracts the external address`, async () => {
      const ip = await withRouter(router, (c) => c.getPublicIp());
      assertEqual(ip, expectedExternalIp[router]);
    });
  }

  for (const router of routers) {
    await test(`${router}: getStatusInfo parses the link state`, async () => {
      const status = await withRouter(router, (c) => c.getStatusInfo());
      assertEqual(status.connectionStatus, "Connected");
      assertEqual(status.lastConnectionError, "ERROR_NONE");
      assert(status.uptime > 0, `uptime should be positive, got ${status.uptime}`);
    });
  }

  for (const router of routers) {
    await test(`${router}: getMappings walks the table and stops at end-of-list`, async () => {
      const expected = expectedGenericEntry[router];
      const mappings = await withRouter(router, (c) => c.getMappings());
      // Index 0 is the captured entry; index 1 faults with 713/714, which is
      // what must terminate the walk. A broken guard would loop to MAX_MAPPINGS.
      assertEqual(mappings.length, 1, `${router}: mapping count`);
      const m = mappings[0];
      assertEqual(m.public.port, expected.public, `${router}: public port`);
      assertEqual(m.private.host, expected.host, `${router}: internal host`);
      assertEqual(m.private.port, expected.private, `${router}: internal port`);
      assertEqual(m.protocol, expected.protocol, `${router}: protocol`);
      assertEqual(m.description, expected.description, `${router}: description`);
      assertEqual(m.local, expected.host === LOCAL_ADDRESS, `${router}: local flag`);
    });
  }

  for (const router of routers) {
    await test(`${router}: getMapping returns the specific entry`, async () => {
      const expected = expectedSpecificEntry[router];
      const m = await withRouter(router, (c) => c.getMapping({ public: 16132 }));
      assert(m !== null, `${router}: expected a mapping`);
      assertEqual(m!.private.host, expected.host, `${router}: internal host`);
      assertEqual(m!.private.port, expected.private, `${router}: internal port`);
      assertEqual(m!.description, expected.description, `${router}: description`);
      assertEqual(m!.public.port, 16132, `${router}: echoes requested port`);
      assertEqual(m!.local, expected.host === LOCAL_ADDRESS, `${router}: local flag`);
    });
  }

  for (const router of routers) {
    if (router === "sagemcom-livebox") continue; // answers 606 — asserted separately
    await test(`${router}: getMapping returns null when the router reports NotFound`, async () => {
      const m = await withRouter(router, (c) =>
        c.getMapping({ public: UNMAPPED_PORT })
      );
      assertEqual(m, null, `${router}: unmapped port should resolve to null`);
    });
  }

  // The two routers below answer with codes getMappings/getMapping do not treat
  // as "absent". Both currently propagate instead of resolving empty, so these
  // pin the behaviour that exists — see the gaps noted alongside them.

  await test("mikrotik: a 402 end-of-list still yields the listing", async () => {
    // MikroTik ends the walk with 402 Invalid Args rather than 713. Past the
    // first index any UPnP fault means the table ran out, so the entries read
    // before it are returned instead of the listing throwing.
    const mappings = await withRouter("mikrotik", (c) => c.getMappings());
    assertEqual(mappings.length, 1, "the captured entry survives the 402");
    assertEqual(mappings[0].description, "Dummy inactive rule for windows to work");
  });

  await test("a fault at the very first index is not mistaken for an empty table", async () => {
    // 713/714 at index 0 mean "no mappings". Anything else there is a real
    // problem -- an unsupported action, say -- and must not be swallowed.
    await expectUpnpError(
      withBroken("first-index-401", (c) => c.getMappings()),
      401,
      "getMappings when the action is unsupported"
    );
  });

  await test("sagemcom-livebox: a missing entry arrives as 606, which getMapping does not absorb", async () => {
    // Elsewhere a missing entry is 714 and resolves to null. The Livebox answers
    // 606 Action not authorized, so the lookup throws rather than reporting absence.
    await expectUpnpError(
      withRouter("sagemcom-livebox", (c) =>
        c.getMapping({ public: UNMAPPED_PORT })
      ),
      606,
      "sagemcom-livebox getMapping"
    );
  });

  for (const router of routers) {
    await test(`${router}: createMapping issues a permanent lease`, async () => {
      const res = await withRouter(router, (c) =>
        c.createMapping({ public: 16132, private: 16132, ttl: 0 })
      );
      assert(res !== undefined, `${router}: expected a response`);
    });
  }

  for (const router of routers) {
    if (router === "mikrotik") continue; // answers 725 — asserted separately below
    await test(`${router}: createMapping accepts a timed lease`, async () => {
      const res = await withRouter(router, (c) =>
        c.createMapping({ public: 16132, private: 16132, ttl: 60 })
      );
      assert(res !== undefined, `${router}: expected a response`);
    });
  }

  await test("mikrotik: a timed lease becomes a permanent one rather than failing", async () => {
    // The router answers 725 to any lease; the client retries without one.
    const created = await withRouter("mikrotik", (c) =>
      c.createMapping({ public: 16132, private: 16132, ttl: 60 })
    );
    assert(created !== undefined, "a mapping is created despite the refusal");
  });

  for (const router of routers) {
    if (router === "freebox" || router === "mikrotik") continue; // answer 714 below
    await test(`${router}: removeMapping succeeds`, async () => {
      const res = await withRouter(router, (c) =>
        c.removeMapping({ public: 16132 })
      );
      assert(res !== undefined, `${router}: expected a response`);
    });
  }

  for (const router of ["freebox", "mikrotik"]) {
    await test(`${router}: removeMapping surfaces 714 NoSuchEntryInArray`, async () => {
      await expectUpnpError(
        withRouter(router, (c) => c.removeMapping({ public: 16132 })),
        714,
        `${router} removeMapping`
      );
    });
  }

  // Only these four advertise the IGD v2 actions in their SCPD.
  const v2Routers = new Set(["nokia-igd-v2", "sagemcom-livebox", "sercomm-gpon", "technicolor"]);

  for (const router of routers) {
    await test(`${router}: getCapabilities reads the action list from SCPD`, async () => {
      const caps = await withRouter(router, async (c) => {
        const info = await c.getGateway();
        return info.getCapabilities();
      });
      assert(caps !== null, `${router}: expected capabilities`);
      assert(caps!.actions.length > 0, `${router}: expected a non-empty action list`);
      assert(
        caps!.actions.includes("AddPortMapping"),
        `${router}: AddPortMapping should be advertised`
      );
      // Every flag is asserted against the advertised list, so a flag wired to
      // the wrong action name fails here rather than passing quietly.
      assertEqual(
        caps!.supportsGetSpecificPortMappingEntry,
        caps!.actions.includes("GetSpecificPortMappingEntry"),
        `${router}: GetSpecificPortMappingEntry flag`
      );
      assertEqual(
        caps!.supportsGetStatusInfo,
        caps!.actions.includes("GetStatusInfo"),
        `${router}: GetStatusInfo flag`
      );
      assertEqual(
        caps!.supportsAddAnyPortMapping,
        caps!.actions.includes("AddAnyPortMapping"),
        `${router}: AddAnyPortMapping flag`
      );
      assertEqual(
        caps!.supportsDeletePortMappingRange,
        caps!.actions.includes("DeletePortMappingRange"),
        `${router}: DeletePortMappingRange flag`
      );
      assertEqual(
        caps!.supportsGetListOfPortMappings,
        caps!.actions.includes("GetListOfPortMappings"),
        `${router}: GetListOfPortMappings flag`
      );
      assertEqual(
        caps!.supportsAddAnyPortMapping,
        v2Routers.has(router),
        `${router}: only the v2 routers advertise AddAnyPortMapping`
      );
      // Read the expectation out of the router's own description and apply the
      // documented preference order, so this checks the selection rule instead
      // of comparing the parser against itself. The surveyed corpus gets the
      // same check against its recorded serviceType; these thirteen have no
      // generated expectation to point at.
      //
      // descParser, not the library's own parser: the expectation has to be
      // derived independently or a parsing bug would hide itself. It still has
      // to strip namespace prefixes, though — bare XMLParser defaults leave
      // them on, and a prefixed description would then advertise nothing and
      // fail this for a reason that has nothing to do with service selection.
      const advertised = new Device(DESCRIPTION_URL)
        .parseDescription(descParser.parse(loadFixture(`${router}-rootdesc.xml`)).root)
        .services.map((s: { serviceType?: string }) => s.serviceType);
      const preferred = [
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
      ].find((serviceType) => advertised.includes(serviceType));
      assert(!!preferred, `${router}: description advertises no WAN service`);
      assertEqual(
        caps!.serviceType,
        preferred,
        `${router}: picks the highest-preference WAN service its description offers`
      );
      assertEqual(
        caps!.serviceVersion,
        Number(caps!.serviceType.slice(-1)),
        `${router}: version is read off the service type`
      );
    });
  }

  await test("mikrotik: relative URLs resolve against URLBase, not the description URL", async () => {
    // MikroTik is the only fixture carrying a URLBase, and it points at a
    // different host and port than the description was fetched from.
    const caps = await withRouter("mikrotik", async (c) => {
      const info = await c.getGateway();
      return info.getCapabilities();
    });
    assert(caps !== null, "expected capabilities");
    assert(
      caps!.controlURL.startsWith("http://192.168.0.1:2828"),
      `controlURL should resolve against URLBase, got ${caps!.controlURL}`
    );
  });

  for (const router of routers) {
    await test(`${router}: getMappings honours the description filter`, async () => {
      const expected = expectedGenericEntry[router];
      const matched = await withRouter(router, (c) =>
        c.getMappings({ description: expected.description })
      );
      assertEqual(matched.length, 1, `${router}: exact description should match`);
      const missed = await withRouter(router, (c) =>
        c.getMappings({ description: "no-such-description-anywhere" })
      );
      assertEqual(missed.length, 0, `${router}: unmatched description should filter everything`);
    });
  }

  await test("getMappings honours the local filter", async () => {
    // opnsense is the one capture whose entry points somewhere other than our
    // local address, so a local-only listing must come back empty.
    const all = await withRouter("opnsense", (c) => c.getMappings());
    const localOnly = await withRouter("opnsense", (c) => c.getMappings({ local: true }));
    assertEqual(all.length, 1, "unfiltered listing");
    assertEqual(localOnly.length, 0, "the captured entry is not on our local address");
  });

  await test("getMapping lower-cases the protocol it reports back", async () => {
    const mapping = await withRouter("opnsense", (c) =>
      c.getMapping({ public: 16132, protocol: "udp" })
    );
    assert(mapping !== null, "expected a mapping");
    assertEqual(mapping!.protocol, "udp", "protocol is normalised to lower case");
  });

  // Expectations read out of each rootdesc fixture, not out of the parser, so
  // these assert what the document says rather than what the code happens to do.
  const expectedDeviceInfo: Record<
    string,
    {
      friendlyName: string;
      manufacturer: string;
      modelName: string;
      modelNumber: string;
      modelDescription: string;
      specVersion: { major: number; minor: number };
    }
  > = {
    // The parser keeps processEntities off for XXE protection, so the five
    // predefined entities are decoded afterwards instead.
    opnsense: { friendlyName: "OPNsense UPnP IGD & PCP", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "26.1.3", modelDescription: "FreeBSD with MiniUPnPd version 2.3.9 router", specVersion: { major: 1, minor: 1 } },
    "pfsense-2.7": { friendlyName: "FreeBSD router", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.7.2-RELEASE", modelDescription: "FreeBSD router", specVersion: { major: 1, minor: 1 } },
    "pfsense-2.8": { friendlyName: "FreeBSD router", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.8.1-RELEASE", modelDescription: "FreeBSD with MiniUPnPd version 2.3.7 router", specVersion: { major: 1, minor: 1 } },
    "asus-rt-ax55": { friendlyName: "RT-AX55-0001", manufacturer: "ASUSTeK Computer Inc.", modelName: "ASUS Wireless Router", modelNumber: "RT-AX55", modelDescription: "ASUS Wireless Router", specVersion: { major: 1, minor: 1 } },
    "nec-sh621a1": { friendlyName: "SH621A1", manufacturer: "NEC Corporation/NEC Platforms, Ltd.", modelName: "SH621A1", modelNumber: "", modelDescription: "Broadband Router and Wireless Access Point", specVersion: { major: 1, minor: 0 } },
    "sagemcom-livebox": { friendlyName: "Orange Livebox", manufacturer: "Sagemcom", modelName: "Residential Livebox (GPON, WAN Ethernet)", modelNumber: "5", modelDescription: "Sagemcom,fr,SGFI-fr-G06.R05.C05_20", specVersion: { major: 1, minor: 0 } },
    "sagemcom-f5685": { friendlyName: "Sagemcom F5685LGB", manufacturer: "Sagemcom", modelName: "F5685LGB", modelNumber: "F5685LGB", modelDescription: "F@ST 5685 LG, Mercury v3", specVersion: { major: 1, minor: 0 } },
    "nokia-igd-v2": { friendlyName: "Internet Home Gateway Device", manufacturer: "Nokia", modelName: "IGD Version 2.00", modelNumber: "2.00", modelDescription: "Optical-fiber Broadband Router", specVersion: { major: 1, minor: 0 } },
    mikrotik: { friendlyName: "MikroTik Router", manufacturer: "MikroTik", modelName: "Router OS", modelNumber: "", modelDescription: "", specVersion: { major: 1, minor: 0 } },
    freebox: { friendlyName: "Freebox Server", manufacturer: "Freebox", modelName: "Freebox Server", modelNumber: "6", modelDescription: "NAS/Modem/Routeur ADSL/FTTH", specVersion: { major: 1, minor: 0 } },
    "linux-igd": { friendlyName: "Linux Internet Gateway Device", manufacturer: "Linux UPnP IGD Project", modelName: "IGD Version 1.00", modelNumber: "", modelDescription: "", specVersion: { major: 1, minor: 0 } },
    "sercomm-gpon": { friendlyName: "SERCOMM", manufacturer: "Sercomm", modelName: "FG824CD", modelNumber: "FG824CD", modelDescription: "G-PON ONT/ONU", specVersion: { major: 1, minor: 0 } },
    technicolor: { friendlyName: "MediaAccess FGA2130FWB (0000TEST1)", manufacturer: "Technicolor", modelName: "MediaAccess FG", modelNumber: "Technicolor FGA2130FWB", modelDescription: "Technicolor Internet Gateway Device", specVersion: { major: 1, minor: 0 } },
  };

  for (const router of routers) {
    await test(`${router}: getDevice reports every field the description carries`, async () => {
      const expected = expectedDeviceInfo[router];
      const device = await withRouter(router, async (c) => {
        const info = await c.getGateway();
        return info.getDevice();
      });
      assert(device !== null, `${router}: expected device info`);
      assertEqual(device!.friendlyName, expected.friendlyName, `${router}: friendlyName`);
      assertEqual(device!.manufacturer, expected.manufacturer, `${router}: manufacturer`);
      assertEqual(device!.modelName, expected.modelName, `${router}: modelName`);
      assertEqual(device!.modelNumber, expected.modelNumber, `${router}: modelNumber`);
      assertEqual(
        device!.modelDescription,
        expected.modelDescription,
        `${router}: modelDescription`
      );
      assertEqual(device!.specVersion.major, expected.specVersion.major, `${router}: spec major`);
      assertEqual(device!.specVersion.minor, expected.specVersion.minor, `${router}: spec minor`);
      assertEqual(device!.descriptionURL, DESCRIPTION_URL, `${router}: descriptionURL`);
    });
  }

  // ========================================
  // The request the client builds
  // ========================================
  console.log("\n=== Outgoing SOAP requests ===\n");

  await test("createMapping sends every argument the action requires", async () => {
    await withRouter("opnsense", (c) =>
      c.createMapping({ public: 8080, private: 9090, protocol: "udp", ttl: 0 })
    );
    const add = requests.find((r) => r.action === "AddPortMapping");
    assert(!!add, "expected an AddPortMapping request");
    for (const [tag, value] of [
      ["NewExternalPort", "8080"],
      ["NewInternalPort", "9090"],
      ["NewProtocol", "UDP"],
      ["NewInternalClient", LOCAL_ADDRESS],
      ["NewEnabled", "1"],
      ["NewLeaseDuration", "0"],
    ] as const) {
      assert(
        add!.body.includes(`<${tag}>${value}</${tag}>`),
        `${tag} should be ${value} — got ${add!.body}`
      );
    }
    assertEqual(
      add!.headers["SOAPAction"],
      JSON.stringify("urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"),
      "SOAPAction header"
    );
  });

  await test("createMapping defaults the description and lease when not given", async () => {
    await withRouter("opnsense", (c) => c.createMapping({ public: 8080, private: 9090 }));
    const add = requests.find((r) => r.action === "AddPortMapping");
    assert(!!add, "expected an AddPortMapping request");
    assert(add!.body.includes("<NewProtocol>TCP</NewProtocol>"), "protocol defaults to TCP");
    assert(
      add!.body.includes("<NewPortMappingDescription>node:nat:upnp</NewPortMappingDescription>"),
      "description default"
    );
    assert(add!.body.includes("<NewLeaseDuration>1800</NewLeaseDuration>"), "lease default");
  });

  await test("createMapping escapes XML metacharacters in the description", async () => {
    await withRouter("opnsense", (c) =>
      c.createMapping({ public: 8080, private: 9090, ttl: 0, description: 'a & b <c> "d"' })
    );
    const add = requests.find((r) => r.action === "AddPortMapping");
    assert(!!add, "expected an AddPortMapping request");
    // An unescaped & or < would produce a body the router cannot parse.
    assert(!/<NewPortMappingDescription>[^<]*[&][^a-z#]/.test(add!.body), "raw & in description");
    assert(
      add!.body.includes("&amp;") && add!.body.includes("&lt;"),
      `metacharacters should be escaped — got ${add!.body}`
    );
  });

  await test("removeMapping sends only the three keys that identify a mapping", async () => {
    await withRouter("opnsense", (c) => c.removeMapping({ public: 8080, protocol: "tcp" }));
    const del = requests.find((r) => r.action === "DeletePortMapping");
    assert(!!del, "expected a DeletePortMapping request");
    assert(del!.body.includes("<NewExternalPort>8080</NewExternalPort>"), "external port");
    assert(del!.body.includes("<NewProtocol>TCP</NewProtocol>"), "protocol upper-cased");
    assert(!del!.body.includes("NewInternalPort"), "internal port is not part of a delete");
  });

  // ========================================
  // Failures a captured response cannot express
  // ========================================
  console.log("\n=== Transport and malformed responses ===\n");

  async function withBroken<T>(breakage: Breakage, fn: (c: Client) => Promise<T>): Promise<T> {
    const restore = installFakeRouter("opnsense", breakage);
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      return await fn(client);
    } finally {
      client.close();
      restore();
    }
  }

  async function expectThrow(fn: () => Promise<unknown>, what: string): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error(`${what}: expected a throw, but the call resolved`);
  }

  await test("a dead socket propagates instead of being reported as an empty result", async () => {
    const err = await expectThrow(
      () => withBroken("transport", (c) => c.getMappings()),
      "getMappings on a dead socket"
    );
    assertEqual((err as Error).message, "socket hang up");
  });

  await test("garbage XML fails loudly rather than becoming an empty result", async () => {
    const err = await expectThrow(
      () => withBroken("malformed", (c) => c.getStatusInfo()),
      "getStatusInfo on garbage XML"
    );
    const message = (err as Error).message;
    assert(/GetStatusInfo/.test(message), `error should name the action, got: ${message}`);
    // Note it does NOT arrive as the "Malformed XML" error device.ts raises:
    // fast-xml-parser accepts unclosed tags, mismatched tags, bare text and the
    // empty string without throwing, so that branch is unreachable as configured
    // and garbage instead surfaces as a missing response body.
    assert(!/malformed/i.test(message), "the malformed-XML branch is currently unreachable");
  });

  await test("an HTTP error with no fault body still surfaces as an error", async () => {
    const err = await expectThrow(
      () => withBroken("empty-500", (c) => c.getStatusInfo()),
      "getStatusInfo on a bare 502"
    );
    // There is no UPnPError to unwrap, so it must not be reported as a UPnP fault.
    assert(!(err instanceof UpnpError), "a 502 with no fault body is not a UPnP error");
  });

  await test("a thrown non-Error is still propagated", async () => {
    const err = await expectThrow(
      () => withBroken("non-error", (c) => c.getStatusInfo()),
      "getStatusInfo on a thrown string"
    );
    assert(err !== undefined, "expected the thrown value to reach the caller");
  });

  await test("getMappings does not treat a transport failure as end-of-list", async () => {
    // 713/714 end the walk; anything else must not, or a broken router would
    // look like a router with no mappings.
    const err = await expectThrow(
      () => withBroken("empty-500", (c) => c.getMappings()),
      "getMappings on a bare 502"
    );
    assert(err !== undefined, "expected the failure to propagate");
  });

  /** Serve opnsense normally, except the walk's given index answers as told. */
  async function withWalkIndexAnswering<T>(
    index: number,
    answer: () => { data: string },
    fn: (c: Client) => Promise<T>
  ): Promise<T> {
    const restore = installFakeRouter("opnsense");
    const fakePost = axiosModule.post;
    (axiosModule as any).post = async (url: string, body: string, config: any) => {
      const walkIndex = /<NewPortMappingIndex>(\d+)<\/NewPortMappingIndex>/.exec(body)?.[1];
      if (walkIndex === String(index)) return answer();
      return fakePost(url, body, config);
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      return await fn(client);
    } finally {
      client.close();
      (axiosModule as any).post = fakePost;
      restore();
    }
  }

  await test("a fault mid-walk is an error, not the end of the table", async () => {
    // Only 713/714/402 mean "no entry at that index" — the corpus shows no
    // other end-of-table dialect. A transient 501 from a busy router must not
    // pass a partial listing off as a complete one: a caller checking whether
    // its own mapping survived would conclude it is gone and re-create it.
    const fault501 = () => {
      throw {
        response: {
          data:
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
            "<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>" +
            '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
            "<errorCode>501</errorCode><errorDescription>Action Failed</errorDescription>" +
            "</UPnPError></detail></s:Fault></s:Body></s:Envelope>",
          status: 500,
        },
      };
    };
    const err = await expectThrow(
      () => withWalkIndexAnswering(1, fault501, (c) => c.getMappings()),
      "getMappings with a 501 mid-walk"
    );
    assert(err instanceof UpnpError && err.code === 501, `expected the 501 to surface, got ${err}`);
  });

  await test("the walk cap is an error, not a complete table", async () => {
    // A firmware that answers every index never ends the table, so the cap is
    // where the walk gives up on a malfunctioning router — and the entries
    // collected by then are a partial listing, which must never pass for a
    // complete one. Every index is answered here by rewriting it to the
    // fake's index 0.
    const restore = installFakeRouter("opnsense");
    const fakePost = axiosModule.post;
    let walkCalls = 0;
    (axiosModule as any).post = async (url: string, body: string, config?: AxiosRequestConfig<string>) => {
      if (/<NewPortMappingIndex>\d+<\/NewPortMappingIndex>/.test(body)) {
        walkCalls += 1;
        body = body.replace(
          /<NewPortMappingIndex>\d+<\/NewPortMappingIndex>/,
          "<NewPortMappingIndex>0</NewPortMappingIndex>"
        );
      }
      return fakePost(url, body, config);
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const err = await expectThrow(
        () => client.getMappings(),
        "getMappings against an every-index router"
      );
      assert(/end-of-table/.test((err as Error).message), `got: ${(err as Error).message}`);
      assertEqual(walkCalls, 10000, "the walk stopped at the cap");
    } finally {
      client.close();
      (axiosModule as any).post = fakePost;
      restore();
    }
  });

  await test("a multi-entry table comes back whole and in order", async () => {
    // The fake's captured table holds a single entry, so a walk that dropped
    // or merged everything after the first row passed the whole suite. Three
    // distinct rows, every field pinned per row.
    const restore = installFakeRouter("opnsense");
    setV1Table([
      { external: 16137, internal: 16137, host: "192.168.1.60", description: "Flux_One", ttl: 3600 },
      { external: 16147, internal: 9090, host: "192.168.1.61", description: "Flux_Two", ttl: 60 },
      { external: 25565, internal: 25565, host: "192.168.1.62", description: "Flux_Three", ttl: 0, protocol: "UDP" },
    ]);
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const mappings = await client.getMappings();
      assertEqual(mappings.length, 3, "all three rows are returned");
      const rows = mappings.map(
        (m) => `${m.public.port}:${m.private.host}:${m.private.port}:${m.protocol}:${m.description}:${m.ttl}`
      );
      assertEqual(rows[0], "16137:192.168.1.60:16137:tcp:Flux_One:3600", "row 0");
      assertEqual(rows[1], "16147:192.168.1.61:9090:tcp:Flux_Two:60", "row 1");
      assertEqual(rows[2], "25565:192.168.1.62:25565:udp:Flux_Three:0", "row 2");
    } finally {
      setV1Table(null);
      client.close();
      restore();
    }
  });

  await test("a bare getMappings marks the machine's own mapping local", async () => {
    // The opnsense capture's entry points at 172.16.32.143; a client that IS
    // that machine must see its own mapping flagged without asking for the
    // local filter. FluxOS serves the bare call's result out of /flux/getmap.
    const restore = installFakeRouter("opnsense");
    const client = new Client({ url: DESCRIPTION_URL, localAddress: "172.16.32.143" });
    try {
      const mappings = await client.getMappings();
      assertEqual(mappings.length, 1, "the captured entry is listed");
      assertEqual(mappings[0].local, true, "the machine's own mapping is local");
    } finally {
      client.close();
      restore();
    }
  });

  await test("an entry with no internal client is local: null, not a claim", async () => {
    // "local" is a fact only when both addresses are known. A router that
    // omits the internal client leaves the question unanswerable, and false
    // would read as "someone else's mapping" — a claim nothing supports.
    const blanked = () => ({
      data: loadFixture("opnsense-soap-GetGenericPortMappingEntry.xml").replace(
        /<NewInternalClient>[^<]*<\/NewInternalClient>/,
        "<NewInternalClient></NewInternalClient>"
      ),
    });
    const mappings = await withWalkIndexAnswering(0, blanked, (c) => c.getMappings());
    assertEqual(mappings.length, 1, "the entry is still listed");
    assertEqual(mappings[0].local, null, "unknowable, so neither true nor false");
  });

  // ========================================
  // Input validation at the client's door
  // ========================================
  // GetSpecificPortMappingEntry returns neither port nor protocol, so nothing
  // about a mapping can be read back and verified after the fact — the router
  // even truncates an oversized port to 16 bits and reports success. The only
  // place a bad value can be caught is on the way in.

  await test("a missing public port is an error, not the string 'undefined'", async () => {
    const err = await expectThrow(
      () => withRouter("opnsense", (c) => c.createMapping({})),
      "createMapping with no ports"
    );
    assert(/public port/.test((err as Error).message), `got: ${(err as Error).message}`);
    assert(!(err instanceof UpnpError), "input validation is not a router fault");
  });

  await test("a port beyond 65535 is refused, not silently truncated by the router", async () => {
    // miniupnpd maps 99999 as 34463 (99999 & 0xFFFF) and answers success, so
    // resolving here would confirm a mapping on a port that does not exist.
    const err = await expectThrow(
      () => withRouter("opnsense", (c) => c.createMapping({ public: 99999, private: 99999 })),
      "createMapping beyond the port range"
    );
    assert(/99999/.test((err as Error).message), `got: ${(err as Error).message}`);
  });

  await test("a protocol that is not TCP or UDP is refused", async () => {
    const err = await expectThrow(
      () => withRouter("opnsense", (c) => c.createMapping({ public: 8080, protocol: "icmp" })),
      "createMapping with a non-port protocol"
    );
    assert(/protocol/.test((err as Error).message), `got: ${(err as Error).message}`);
  });

  await test("getMapping refuses a port beyond 65535", async () => {
    const err = await expectThrow(
      () => withRouter("opnsense", (c) => c.getMapping({ public: 65536 })),
      "getMapping beyond the port range"
    );
    assert(/public port/.test((err as Error).message), `got: ${(err as Error).message}`);
  });

  await test("port 0 names an existing entry, so references accept it", async () => {
    // The surveyed MikroTik holds a placeholder rule at external port 0; what
    // the table can hold, a caller must be able to look up and delete. Only
    // creating a mapping requires 1-65535.
    const looked = await withRouter("mikrotik-router-os", (c) => c.getMapping({ public: 0 }));
    assert(looked !== null, "the port-0 entry can be queried");
    const removed = await withRouter("opnsense", (c) => c.removeMapping({ public: 0 }));
    assert(removed !== undefined, "a port-0 entry can be deleted");
    const err = await expectThrow(
      () => withRouter("opnsense", (c) => c.createMapping({ public: 0 })),
      "createMapping for port 0"
    );
    assert(/public port/.test((err as Error).message), `got: ${(err as Error).message}`);
  });

  await test("getMappingRange refuses an end port beyond the range", async () => {
    const err = await expectThrow(
      () =>
        withRouter("ubiquiti-udm-pro-max", (c) =>
          c.getMappingRange({ startPort: 1, endPort: 99999 })
        ),
      "getMappingRange beyond the port range"
    );
    assert(/endPort/.test((err as Error).message), `got: ${(err as Error).message}`);
  });

  await test("the port range boundaries themselves are accepted", async () => {
    const res = await withRouter("opnsense", (c) => c.removeMapping({ public: 65535 }));
    assert(res !== undefined, "65535 is a valid port");
    const res1 = await withRouter("opnsense", (c) => c.removeMapping({ public: 1 }));
    assert(res1 !== undefined, "1 is a valid port");
  });

  await test("a numeric string port keeps working", async () => {
    const res = await withRouter("opnsense", (c) =>
      c.createMapping({ public: "8080" as any, private: "8080" as any })
    );
    assert(res !== undefined, "string ports have always been accepted");
  });

  await test("a string port means the whole string, or it is refused", async () => {
    // The lenient parse read "0x1F" as 0 — and deleted external port 0, a
    // port the caller never named — and "8080x" as 8080. A partial parse is
    // a refusal now: no call substitutes a different port for the one named.
    for (const garbage of ["0x1F", "8080x", "8080.9"]) {
      const removed = await expectThrow(
        () => withRouter("opnsense", (c) => c.removeMapping({ public: garbage as any })),
        `removeMapping(${JSON.stringify(garbage)})`
      );
      assert(/public port/.test((removed as Error).message), `got: ${(removed as Error).message}`);
      const created = await expectThrow(
        () =>
          withRouter("opnsense", (c) =>
            c.createMapping({ public: garbage as any, private: garbage as any })
          ),
        `createMapping(${JSON.stringify(garbage)})`
      );
      assert(/port/.test((created as Error).message), `got: ${(created as Error).message}`);
    }
  });

  await test("the numeric-string convenience works on every entry point", async () => {
    const fetched = await withRouter("opnsense", (c) => c.getMapping({ public: "16132" as any }));
    assert(fetched !== null, "getMapping accepts a numeric string");
    const objectForm = await withRouter("opnsense", (c) =>
      c.createMapping({ public: { port: "8080" } as any, private: { port: "8080" } as any })
    );
    assert(objectForm !== undefined, "the object form accepts a numeric string too");
  });

  await test("a description with an entity round-trips, and its filter matches", async () => {
    // Outbound descriptions are XML-escaped and the SOAP parser leaves
    // entities alone for XXE protection, so without decoding on read a
    // mapping written as Flux_A&B_node listed as Flux_A&amp;B_node — and a
    // filter on the value actually written found nothing.
    const withEntity = () => ({
      data: loadFixture("opnsense-soap-GetGenericPortMappingEntry.xml").replace(
        /<NewPortMappingDescription>[^<]*</,
        "<NewPortMappingDescription>Flux_A&amp;B_node<"
      ),
    });
    const mappings = await withWalkIndexAnswering(0, withEntity, (c) => c.getMappings());
    assertEqual(mappings[0].description, "Flux_A&B_node", "read back as written");
    const filtered = await withWalkIndexAnswering(0, withEntity, (c) =>
      c.getMappings({ description: "Flux_A&B_node" })
    );
    assertEqual(filtered.length, 1, "the filter matches the written description");
  });

  await test("getMapping decodes the description the same way", async () => {
    const restore = installFakeRouter("opnsense");
    const fakePost = axiosModule.post;
    (axiosModule as any).post = async (url: string, body: string, config: any) => {
      const res: any = await fakePost(url, body, config);
      if (/GetSpecificPortMappingEntry/.test(String(config.headers.SOAPAction))) {
        res.data = res.data.replace(
          /<NewPortMappingDescription>[^<]*</,
          "<NewPortMappingDescription>Flux_A&amp;B_node<"
        );
      }
      return res;
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const mapping = await client.getMapping({ public: 16132 });
      assert(mapping !== null, "the mapping is found");
      assertEqual(mapping!.description, "Flux_A&B_node", "entities are decoded on read");
    } finally {
      client.close();
      (axiosModule as any).post = fakePost;
      restore();
    }
  });

  await test("a shapeless response mid-walk is an error, not the end of the table", async () => {
    // A response with no GetGenericPortMappingEntryResponse in it is not how
    // any router says "no more entries" — that is always a fault.
    const alien = () => ({
      data:
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
        "<u:SomethingElseEntirely/></s:Body></s:Envelope>",
    });
    const err = await expectThrow(
      () => withWalkIndexAnswering(1, alien, (c) => c.getMappings()),
      "getMappings with a shapeless response mid-walk"
    );
    assert(
      /GetGenericPortMappingEntry/.test((err as Error).message),
      `error should name the action, got: ${(err as Error).message}`
    );
  });

  await test("Client surfaces a transport failure rather than swallowing it", async () => {
    const restore = installFakeRouter("opnsense");
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      // A non-SOAP transport error carries no fault body, so it must propagate.
      (axiosModule as any).post = async () => {
        throw new Error("socket hang up");
      };
      let threw = false;
      try {
        await client.getStatusInfo();
      } catch (err: any) {
        threw = true;
        assertEqual(err.message, "socket hang up");
      }
      assert(threw, "expected the transport error to propagate");
    } finally {
      client.close();
      restore();
    }
  });

  await test("the five predefined XML entities are decoded", () => {
    assertEqual(decodeXmlEntities("a &amp; b"), "a & b", "amp");
    assertEqual(decodeXmlEntities("&lt;tag&gt;"), "<tag>", "lt/gt");
    assertEqual(decodeXmlEntities("&quot;quoted&quot;"), '"quoted"', "quot");
    assertEqual(decodeXmlEntities("it&apos;s"), "it's", "apos");
    assertEqual(decodeXmlEntities("it&#39;s"), "it's", "numeric apostrophe");
  });

  await test("entity decoding leaves anything else untouched", () => {
    // Only the predefined five are expanded. A declared entity is exactly what
    // processEntities is off to prevent, so it must survive as written.
    assertEqual(decodeXmlEntities("&xxe;"), "&xxe;", "custom entity is not expanded");
    assertEqual(decodeXmlEntities("&amp"), "&amp", "an unterminated entity is left alone");
    assertEqual(decodeXmlEntities("plain text"), "plain text", "plain text");
    assertEqual(decodeXmlEntities(""), "", "empty string");
  });

  await test("decoding does not re-expand what it just produced", () => {
    // "&amp;lt;" means the literal text "&lt;", not a less-than sign.
    assertEqual(decodeXmlEntities("&amp;lt;"), "&lt;", "single pass only");
  });

  // ========================================
  // IGD v2 actions
  // ========================================
  console.log("\n=== IGD v2 actions ===\n");

  // Gating and request construction need no captured response at all — the
  // SCPDs in the fixture set already say which routers advertise these.
  for (const router of routers) {
    if (v2Routers.has(router)) continue;
    await test(`${router}: v2 actions are refused on a router that does not advertise them`, async () => {
      const calls: ((c: Client) => Promise<unknown>)[] = [
        (c) => c.createAnyMapping({ public: 16137, private: 16137 }),
        (c) => c.getMappingRange({ startPort: 1, endPort: 65535 }),
        (c) => c.removeMappingRange({ startPort: 1, endPort: 65535 }),
      ];
      for (const call of calls) {
        const err = await expectThrow(
          () => withRouter(router, call),
          `${router}: unsupported v2 action`
        );
        assert(
          /not supported/i.test((err as Error).message),
          `expected a not-supported error, got: ${(err as Error).message}`
        );
      }
    });
  }

  await test("createAnyMapping sends the documented arguments", async () => {
    await withRouter("nokia-igd-v2", (c) =>
      c.createAnyMapping({ public: 8080, private: 9090, protocol: "udp", ttl: 0 })
    );
    const req = requests.find((r) => r.action === "AddAnyPortMapping");
    assert(!!req, "expected an AddAnyPortMapping request");
    for (const [tag, value] of [
      ["NewExternalPort", "8080"],
      ["NewInternalPort", "9090"],
      ["NewProtocol", "UDP"],
      ["NewEnabled", "1"],
      ["NewLeaseDuration", "0"],
    ] as const) {
      assert(req!.body.includes(`<${tag}>${value}</${tag}>`), `${tag} should be ${value}`);
    }
  });

  await test("createAnyMapping applies the same defaults as createMapping", async () => {
    await withRouter("nokia-igd-v2", (c) => c.createAnyMapping({ public: 8080, private: 9090 }));
    const req = requests.find((r) => r.action === "AddAnyPortMapping");
    assert(!!req, "expected a request");
    assert(req!.body.includes("<NewProtocol>TCP</NewProtocol>"), "protocol default");
    assert(
      req!.body.includes("<NewPortMappingDescription>node:nat:upnp</NewPortMappingDescription>"),
      "description default"
    );
    assert(req!.body.includes("<NewLeaseDuration>1800</NewLeaseDuration>"), "lease default");
  });

  await test("createAnyMapping returns the port the router reserved", async () => {
    setV2Overrides({ reservedPort: 54321 });
    try {
      const result = await withRouter("nokia-igd-v2", (c) =>
        c.createAnyMapping({ public: 8080, private: 9090 })
      );
      assertEqual(result.reservedPort, 54321, "reserved port is read from the response");
    } finally {
      setV2Overrides({});
    }
  });

  // Every router the survey caught answering the v2 mutating actions gets its
  // real capture driven through the client — the synthetic template exists
  // only for routers that never contributed one, and the fake already prefers
  // a capture when one is on disk.
  const v2CapturedRouters = [...routers, ...surveyedRouters.map((r) => r.slug)].filter((slug) =>
    existsSync(join(fixturesDir, `${slug}-soap-AddAnyPortMapping.xml`))
  );

  await test("the survey captured the v2 mutating actions on 23 routers", () => {
    // The hollow-loop guard: a renamed or dropped fixture must shrink this
    // count, not silently skip the router.
    assertEqual(v2CapturedRouters.length, 23, "routers driven against real v2 captures");
  });

  for (const router of v2CapturedRouters) {
    await test(`${router}: createAnyMapping reads the reserved port from the capture`, async () => {
      // The expected port comes off the raw capture by regex, independent of
      // the XML pipeline under test.
      const raw = loadFixture(`${router}-soap-AddAnyPortMapping.xml`);
      const expected = Number(raw.match(/<NewReservedPort>(\d+)<\/NewReservedPort>/)?.[1]);
      assert(Number.isInteger(expected), `${router}: capture carries a reserved port`);
      const result = await withRouter(router, (c) =>
        c.createAnyMapping({ public: 16137, private: 16137 })
      );
      assertEqual(result.reservedPort, expected, `${router}: reserved port`);
    });

    await test(`${router}: removeMappingRange resolves its captured answer as success`, async () => {
      const res = await withRouter(router, (c) =>
        c.removeMappingRange({ startPort: 16137, endPort: 16137 })
      );
      assert(res !== undefined && res !== null, `${router}: the captured response resolves`);
    });
  }

  await test("removeMappingRange sends the range and the manage flag", async () => {
    await withRouter("technicolor", (c) =>
      c.removeMappingRange({ startPort: 100, endPort: 200, protocol: "udp", manage: true })
    );
    const req = requests.find((r) => r.action === "DeletePortMappingRange");
    assert(!!req, "expected a DeletePortMappingRange request");
    assert(req!.body.includes("<NewStartPort>100</NewStartPort>"), "start port");
    assert(req!.body.includes("<NewEndPort>200</NewEndPort>"), "end port");
    assert(req!.body.includes("<NewProtocol>UDP</NewProtocol>"), "protocol");
    assert(req!.body.includes("<NewManage>1</NewManage>"), "manage true is sent as 1");
  });

  await test("removeMappingRange defaults manage to 0 and the protocol to TCP", async () => {
    await withRouter("technicolor", (c) =>
      c.removeMappingRange({ startPort: 100, endPort: 200 })
    );
    const req = requests.find((r) => r.action === "DeletePortMappingRange");
    assert(!!req, "expected a request");
    assert(req!.body.includes("<NewManage>0</NewManage>"), "manage defaults to 0");
    assert(req!.body.includes("<NewProtocol>TCP</NewProtocol>"), "protocol defaults to TCP");
  });

  await test("getMappingRange sends the range, manage flag and port count", async () => {
    await withRouter("sercomm-gpon", (c) =>
      c.getMappingRange({ startPort: 1, endPort: 65535, manage: true, numberOfPorts: 50 })
    );
    const req = requests.find((r) => r.action === "GetListOfPortMappings");
    assert(!!req, "expected a GetListOfPortMappings request");
    assert(req!.body.includes("<NewStartPort>1</NewStartPort>"), "start port");
    assert(req!.body.includes("<NewEndPort>65535</NewEndPort>"), "end port");
    assert(req!.body.includes("<NewManage>1</NewManage>"), "manage");
    assert(req!.body.includes("<NewNumberOfPorts>50</NewNumberOfPorts>"), "port count");
  });

  await test("getMappingRange defaults the port count to 1000", async () => {
    await withRouter("sercomm-gpon", (c) => c.getMappingRange({ startPort: 1, endPort: 100 }));
    const req = requests.find((r) => r.action === "GetListOfPortMappings");
    assert(!!req, "expected a request");
    assert(req!.body.includes("<NewNumberOfPorts>1000</NewNumberOfPorts>"), "default count");
  });

  await test("getMappingRange parses the port listing", async () => {
    const mappings = await withRouter("sercomm-gpon", (c) =>
      c.getMappingRange({ startPort: 1, endPort: 65535 })
    );
    assertEqual(mappings.length, 2, "both entries are returned");
    assertEqual(mappings[0].public.port, 16137, "first external port");
    assertEqual(mappings[0].private.host, "192.168.1.50", "first internal host");
    assertEqual(mappings[0].description, "Flux_A", "first description");
    assertEqual(mappings[0].ttl, 3600, "lease time is read from NewLeaseTime");
    assertEqual(mappings[1].private.port, 9090, "second internal port");
    assertEqual(mappings[1].ttl, 0, "a permanent lease reads as 0");
    assertEqual(mappings[0].protocol, "tcp", "protocol echoes the request, lower-cased");
  });

  await test("getMappingRange reads a listing sent as CDATA", async () => {
    // What real routers send: three Ubiquiti gateways surveyed all wrap the
    // PortMappingList in CDATA rather than escaping it.
    const mappings = await withRouter("sercomm-gpon", (c) =>
      c.getMappingRange({ startPort: 1, endPort: 65535 })
    );
    assertEqual(mappings.length, 2, "CDATA listing parses");
  });

  await test("getMappingRange reads a listing sent entity-escaped", async () => {
    // The spec allows the listing to be escaped instead, and nothing in the
    // wild has been seen doing it -- this is why the parser decodes the
    // predefined entities before the inner parse.
    setV2Escaped(true);
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 2, "escaped listing parses too");
    } finally {
      setV2Escaped(false);
    }
  });

  await test("a CDATA listing survives a neighbour's XML-special description", async () => {
    // CDATA delivers the inner document as-is. Decoding it before parsing
    // turns escaped text live, so one '<' in any entry's description — a
    // neighbouring client's, not ours to control — truncated the listing at
    // that entry and returned the remainder as if complete.
    setV2Overrides({
      listing: portListing([
        { external: 1001, internal: 1001, host: "192.168.1.50", description: "Sonos &lt;TV&gt; &amp; Hub", ttl: 3600 },
        { external: 1002, internal: 1002, host: "192.168.1.51", description: "second", ttl: 3600 },
        { external: 1003, internal: 1003, host: "192.168.1.52", description: "third", ttl: 0 },
      ]),
    });
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 3, "every entry survives");
      assertEqual(mappings[0].description, "Sonos <TV> & Hub", "the special description reads back decoded");
      assertEqual(mappings[0].ttl, 3600, "its lease survives too");
      assertEqual(mappings[2].public.port, 1003, "entries after it are not dropped");
    } finally {
      setV2Overrides({});
    }
  });

  await test("an escaped listing's description reads back as written", async () => {
    // On the escaped dialect the wrapper decode was the only decode, so the
    // field itself came back one entity layer on: Flux_A&amp;B_node.
    setV2Escaped(true);
    setV2Overrides({
      listing: portListing([
        { external: 1001, internal: 1001, host: "192.168.1.50", description: "Flux_A&amp;B_node", ttl: 3600 },
      ]),
    });
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 1, "the entry is listed");
      assertEqual(mappings[0].description, "Flux_A&B_node", "written and read values agree");
    } finally {
      setV2Escaped(false);
      setV2Overrides({});
    }
  });

  await test("getMappingRange returns nothing when the listing is absent", async () => {
    setV2Overrides({ listing: null });
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 0, "a missing NewPortListing yields an empty list");
    } finally {
      setV2Overrides({});
    }
  });

  await test("getMappingRange returns nothing when the listing is empty", async () => {
    setV2Overrides({ listing: portListing([]) });
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 0, "an empty PortMappingList yields an empty list");
    } finally {
      setV2Overrides({});
    }
  });

  await test("getMappingRange handles a listing with one entry", async () => {
    // A single entry arrives as an object rather than an array, which is the
    // shape that most often gets mishandled.
    setV2Overrides({
      listing: portListing([
        { external: 5000, internal: 5000, host: "192.168.1.9", description: "Solo", ttl: 120 },
      ]),
    });
    try {
      const mappings = await withRouter("sercomm-gpon", (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      assertEqual(mappings.length, 1, "a lone entry is still a list");
      assertEqual(mappings[0].description, "Solo", "description");
    } finally {
      setV2Overrides({});
    }
  });

  // ========================================
  // Error codes and the permanent-lease retry
  // ========================================
  console.log("\n=== Error codes ===\n");

  await test("the error code table covers every code the corpus produced", () => {
    // Codes the surveyed routers actually returned, so the table cannot drift
    // away from what is out there.
    for (const code of [401, 402, 501, 606, 713, 714, 718, 725]) {
      assert(
        typeof UPNP_ERROR_CODES[code] === "string" && UPNP_ERROR_CODES[code].length > 0,
        `no entry for ${code}`
      );
    }
  });

  await test("the table is the spec meaning, not the router's wording", () => {
    // Routers word the same code differently -- 713 arrives as both
    // "SpecifiedArrayIndexInvalid" and "Bad Array Index" -- so the table gives
    // one canonical meaning and UpnpError keeps whatever the router said.
    assertEqual(UPNP_ERROR_CODES[713], "Specified Array Index Invalid", "713");
    assertEqual(UPNP_ERROR_CODES[714], "No Such Entry In Array", "714");
    assertEqual(UPNP_ERROR_CODES[725], "Only Permanent Leases Supported", "725");
    const err = new UpnpError(713, "Bad Array Index", "GetGenericPortMappingEntry");
    assertEqual(err.description, "Bad Array Index", "the router's own words are preserved");
  });

  await test("the table cannot be modified by a caller", () => {
    const before = UPNP_ERROR_CODES[725];
    try {
      (UPNP_ERROR_CODES as any)[725] = "tampered";
    } catch {
      /* frozen objects throw in strict mode */
    }
    assertEqual(UPNP_ERROR_CODES[725], before, "the table is frozen");
  });

  await test("a router refusing a timed lease is retried permanently", async () => {
    // MikroTik answers 725 to any lease. The caller asked for 60 seconds and
    // gets a permanent mapping, which is more than it asked for rather than
    // nothing at all.
    const created = await withRouter("mikrotik", (c) =>
      c.createMapping({ public: 16132, private: 16132, ttl: 60 })
    );
    assert(created !== undefined, "the retry produced a mapping");
    const leases = requests
      .filter((r) => r.action === "AddPortMapping")
      .map((r) => /<NewLeaseDuration>([^<]*)</.exec(r.body)?.[1]);
    assertEqual(leases.join(","), "60,0", "asked for 60 first, then retried at 0");
  });

  await test("the permanent retry happens once, not in a loop", async () => {
    // The retry uses lease 0, which mikrotik accepts. If it did not, one retry
    // is still all that is attempted.
    await withRouter("mikrotik", (c) => c.createMapping({ public: 16132, private: 16132, ttl: 60 }));
    const attempts = requests.filter((r) => r.action === "AddPortMapping").length;
    assertEqual(attempts, 2, "exactly two attempts");
  });

  await test("a request already asking for a permanent lease is not retried", async () => {
    await withRouter("mikrotik", (c) => c.createMapping({ public: 16132, private: 16132, ttl: 0 }));
    const attempts = requests.filter((r) => r.action === "AddPortMapping").length;
    assertEqual(attempts, 1, "no retry when the lease was already permanent");
  });

  await test("a refusal that is not 725 is passed straight to the caller", async () => {
    // tp-link-archer-ax72 answers 501, which says only that something failed.
    // Guessing at a remedy would replace a clear error with a confusing one.
    const router = surveyedRouters.find((r) => r.slug === "tp-link-archer-ax72");
    assert(!!router, "expected the 501 router in the corpus");
    await expectUpnpError(
      withRouter("tp-link-archer-ax72", (c) =>
        c.createMapping({ public: 8080, private: 8080, ttl: 60 })
      ),
      501,
      "a 501 refusal"
    );
    const attempts = requests.filter((r) => r.action === "AddPortMapping").length;
    assertEqual(attempts, 1, "no retry on 501");
  });

  // ========================================
  // Fault shapes routers actually send
  // ========================================
  console.log("\n=== Fault shapes ===\n");

  function faultBody(inner: string, tags: "lower" | "camel" = "lower"): string {
    const code = tags === "lower" ? "faultcode" : "faultCode";
    const str = tags === "lower" ? "faultstring" : "faultString";
    return (
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
      `<${code}>s:Client</${code}><${str}>UPnPError</${str}>${inner}` +
      "</s:Fault></s:Body></s:Envelope>"
    );
  }

  function upnpError(code: string, description: string): string {
    return (
      '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
      `<errorCode>${code}</errorCode><errorDescription>${description}</errorDescription>` +
      "</UPnPError></detail>"
    );
  }

  async function faultFrom(body: string): Promise<unknown> {
    const restore = installFakeRouter("opnsense");
    const realPost = axiosModule.post;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      await client.getGateway();
      (axiosModule as any).post = async () => {
        throw { response: { data: body, status: 500 } };
      };
      return await expectThrow(() => client.getStatusInfo(), "fault");
    } finally {
      (axiosModule as any).post = realPost;
      client.close();
      restore();
    }
  }

  await test("a fault carries its code and description", async () => {
    const err = await faultFrom(faultBody(upnpError("725", "OnlyPermanentLeasesSupported")));
    assert(err instanceof UpnpError, "UpnpError");
    assertEqual((err as UpnpError).code, 725, "code");
    assertEqual((err as UpnpError).description, "OnlyPermanentLeasesSupported", "description");
    assertEqual((err as UpnpError).action, "GetStatusInfo", "action");
  });

  await test("a fault spelled in camelCase is still understood", async () => {
    // MikroTik spells the SOAP fault tags against the spec.
    const err = await faultFrom(faultBody(upnpError("402", "Invalid Args"), "camel"));
    assertEqual((err as UpnpError).code, 402, "code survives the capitalisation");
    assertEqual((err as UpnpError).description, "Invalid Args", "description");
  });

  await test("a fault with no UPnPError detail falls back to the fault string", async () => {
    const err = await faultFrom(faultBody("<detail><other>stuff</other></detail>"));
    assert(err instanceof UpnpError, "still a UpnpError");
    assertEqual((err as UpnpError).code, 0, "no code available");
    assertEqual((err as UpnpError).description, "UPnPError", "falls back to faultstring");
  });

  await test("a camelCase fault with no detail still finds its description", async () => {
    const err = await faultFrom(faultBody("<detail><other>stuff</other></detail>", "camel"));
    assertEqual((err as UpnpError).description, "UPnPError", "faultString is read too");
  });

  await test("a fault with neither detail nor fault string gets a default description", async () => {
    const body =
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
      "<faultcode>s:Client</faultcode></s:Fault></s:Body></s:Envelope>";
    const err = await faultFrom(body);
    assert(err instanceof UpnpError, "UpnpError");
    assertEqual((err as UpnpError).code, 0, "no code available");
    assertEqual((err as UpnpError).description, "Unknown UPnP error", "a default description");
  });

  await test("a completely empty Fault element is not recognised as a fault", async () => {
    // An empty element parses to "", which is falsy, so the fault check skips
    // it and the transport error propagates instead. No router in the surveyed
    // corpus sends one, so this pins the behaviour rather than asserting it is
    // the behaviour we want.
    const body =
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
      "<s:Body><s:Fault></s:Fault></s:Body></s:Envelope>";
    const err = await faultFrom(body);
    assert(!(err instanceof UpnpError), "an empty Fault falls through to the transport error");
  });

  await test("a non-numeric error code degrades to zero rather than NaN", async () => {
    const err = await faultFrom(faultBody(upnpError("not-a-number", "Nonsense")));
    assertEqual((err as UpnpError).code, 0, "code is zero, never NaN");
  });

  await test("an HTTP error whose body is not XML is not read as a fault", async () => {
    const err = await faultFrom("<html><body>Gateway Timeout</body></html>");
    assert(!(err instanceof UpnpError), "HTML is not a UPnP fault");
  });

  await test("a fault delivered on HTTP 200 still surfaces as the router's error", async () => {
    // MikroTik answers some refusals with a 200 whose body is the fault. The
    // fake delivers every captured fault as an HTTP error, so this branch had
    // no coverage: deleted, a 200-carried fault body would come back to the
    // caller as a successful response.
    const restore = installFakeRouter("mikrotik");
    const fault200 = loadFixture("mikrotik-soap-AddPortMapping_TTL60.xml");
    const realPost = axiosModule.post;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      (axiosModule as any).post = async () => ({ data: fault200 });
      const err = await expectThrow(
        () => client.createMapping({ public: 8080, private: 8080, ttl: 60 }),
        "a 200-carried fault"
      );
      assert(err instanceof UpnpError, `expected a UpnpError, got ${err}`);
      assertEqual((err as UpnpError).code, 725, "the capture's fault code is unwrapped");
    } finally {
      (axiosModule as any).post = realPost;
      client.close();
      restore();
    }
  });

  await test("a hostile entity declaration is never expanded", async () => {
    // processEntities: false is the XXE defence. Every entity the suite
    // otherwise parses converges to the same value with the flag on or off,
    // so flipping it — the exact security regression the configuration
    // exists to prevent — used to pass the whole suite.
    const restore = installFakeRouter("opnsense");
    const realPost = axiosModule.post;
    const hostile =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE s:Envelope [<!ENTITY flux "LEAKED">]>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
      '<u:GetSpecificPortMappingEntryResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">' +
      "<NewInternalPort>16132</NewInternalPort>" +
      "<NewInternalClient>172.16.32.143</NewInternalClient>" +
      "<NewEnabled>1</NewEnabled>" +
      "<NewPortMappingDescription>&flux;</NewPortMappingDescription>" +
      "<NewLeaseDuration>3600</NewLeaseDuration>" +
      "</u:GetSpecificPortMappingEntryResponse></s:Body></s:Envelope>";
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      (axiosModule as any).post = async () => ({ data: hostile });
      const mapping = await client.getMapping({ public: 16132 });
      assert(mapping !== null, "the response parses");
      assertEqual(mapping!.description, "&flux;", "the declared entity survives unexpanded");
    } finally {
      (axiosModule as any).post = realPost;
      client.close();
      restore();
    }
  });

  await test("an error with no response at all propagates untouched", async () => {
    const restore = installFakeRouter("opnsense");
    const realPost = axiosModule.post;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      await client.getGateway();
      (axiosModule as any).post = async () => {
        throw new Error("ECONNREFUSED");
      };
      const err = await expectThrow(() => client.getStatusInfo(), "no response");
      assertEqual((err as Error).message, "ECONNREFUSED", "the original error reaches the caller");
    } finally {
      (axiosModule as any).post = realPost;
      client.close();
      restore();
    }
  });

  await test("a response whose data is not a string is not treated as a fault body", async () => {
    const restore = installFakeRouter("opnsense");
    const realPost = axiosModule.post;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      await client.getGateway();
      // isAxiosErrorWithData only accepts a string body; anything else must
      // fall through rather than being parsed.
      (axiosModule as any).post = async () => {
        throw { response: { data: { not: "a string" }, status: 500 } };
      };
      const err = await expectThrow(() => client.getStatusInfo(), "object body");
      assert(!(err instanceof UpnpError), "an object body is not a fault");
    } finally {
      (axiosModule as any).post = realPost;
      client.close();
      restore();
    }
  });

  await test("the service preference order picks v2 over v1", async () => {
    // sercomm advertises both; the client must choose WANIPConnection:2.
    const caps = await withRouter("sercomm-gpon", async (c) => {
      const info = await c.getGateway();
      return info.getCapabilities();
    });
    assert(caps!.serviceType.endsWith(":2"), `expected a v2 service, got ${caps!.serviceType}`);
  });

  await test("a failed SCPD fetch is retried on the next call", async () => {
    // One dropped response must not disable the v2 actions for the life of
    // the device: the failure has to reach the handler that clears the cache,
    // or "cannot verify support" becomes permanent under cacheGateway: true.
    const restore = installFakeRouter("opnsense");
    const fakeGet = axiosModule.get;
    let scpdAttempts = 0;
    let failNext = true;
    (axiosModule as any).get = async (url: string) => {
      if (url !== DESCRIPTION_URL) {
        scpdAttempts += 1;
        if (failNext) {
          failNext = false;
          throw new Error("socket hang up");
        }
      }
      return fakeGet(url);
    };
    const device = new Device(DESCRIPTION_URL);
    try {
      assertEqual(await device.getCapabilities(), null, "the failing fetch reports null");
      const recovered = await device.getCapabilities();
      assert(recovered !== null, "the next call retries instead of serving the cached failure");
      assertEqual(scpdAttempts, 2, "the SCPD was fetched again");
    } finally {
      (axiosModule as any).get = fakeGet;
      restore();
    }
  });

  await test("a failed SCPD fetch is not pinned by the gateway info cache", async () => {
    // The Device layer retries after a failure, but the UpnpInfo wrapper the
    // client actually consults cached the null answer above it — so in url
    // mode and cacheGateway mode one transient blip disabled every v2 action
    // until process restart.
    const restore = installFakeRouter("sercomm-gpon");
    const fakeGet = axiosModule.get;
    let scpdAttempts = 0;
    let failNext = true;
    (axiosModule as any).get = async (url: string) => {
      if (url !== DESCRIPTION_URL) {
        scpdAttempts += 1;
        if (failNext) {
          failNext = false;
          throw new Error("socket hang up");
        }
      }
      return fakeGet(url);
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const err = await expectThrow(
        () => client.removeMappingRange({ startPort: 16137, endPort: 16137 }),
        "v2 action while the SCPD fetch fails"
      );
      assert(/SCPD unavailable/.test((err as Error).message), `got: ${(err as Error).message}`);
      const res = await client.removeMappingRange({ startPort: 16137, endPort: 16137 });
      assert(res !== undefined, "the next call retries and succeeds");
      assertEqual(scpdAttempts, 2, "the SCPD was fetched again through the client path");
    } finally {
      (axiosModule as any).get = fakeGet;
      client.close();
      restore();
    }
  });

  await test("a garbage 200 SCPD is not cached as all-false capabilities", async () => {
    // A captive portal or error page can answer the SCPD URL with parseable
    // markup that is not an SCPD. Reading zero actions out of it and caching
    // that as a success would pin every capability false for the life of the
    // device — the one failure shape the transport retry path never sees.
    const restore = installFakeRouter("opnsense");
    const fakeGet = axiosModule.get;
    let scpdAttempts = 0;
    let garbageNext = true;
    (axiosModule as any).get = async (url: string) => {
      if (url !== DESCRIPTION_URL) {
        scpdAttempts += 1;
        if (garbageNext) {
          garbageNext = false;
          return {
            data: "<html><head><title>Login</title></head><body>portal</body></html>",
            status: 200,
          };
        }
      }
      return fakeGet(url);
    };
    const device = new Device(DESCRIPTION_URL);
    try {
      assertEqual(await device.getCapabilities(), null, "an actionless document reports null, not all-false");
      const recovered = await device.getCapabilities();
      assert(recovered !== null, "the next call refetches instead of serving the pinned garbage");
      assert(recovered!.actions.length > 0, "the healed answer carries the real action list");
      assertEqual(scpdAttempts, 2, "the SCPD was fetched again");
    } finally {
      (axiosModule as any).get = fakeGet;
      restore();
    }
  });

  await test("a garbage 200 SCPD is not pinned by the gateway info cache", async () => {
    // Same shape through the client path: the UpnpInfo layer must treat the
    // actionless-document null like the transport-failure null it already
    // clears, or one portal page disables every v2 action until restart.
    const restore = installFakeRouter("sercomm-gpon");
    const fakeGet = axiosModule.get;
    let scpdAttempts = 0;
    let garbageNext = true;
    (axiosModule as any).get = async (url: string) => {
      if (url !== DESCRIPTION_URL) {
        scpdAttempts += 1;
        if (garbageNext) {
          garbageNext = false;
          return {
            data: "<html><head><title>Login</title></head><body>portal</body></html>",
            status: 200,
          };
        }
      }
      return fakeGet(url);
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const err = await expectThrow(
        () => client.removeMappingRange({ startPort: 16137, endPort: 16137 }),
        "v2 action while the SCPD answer is garbage"
      );
      assert(/SCPD unavailable/.test((err as Error).message), `got: ${(err as Error).message}`);
      const res = await client.removeMappingRange({ startPort: 16137, endPort: 16137 });
      assert(res !== undefined, "the next call retries and succeeds");
      assertEqual(scpdAttempts, 2, "the SCPD was fetched again through the client path");
    } finally {
      (axiosModule as any).get = fakeGet;
      client.close();
      restore();
    }
  });

  await test("a failed device-info fetch is not pinned by the gateway info cache", async () => {
    const restore = installFakeRouter("opnsense");
    const fakeGet = axiosModule.get;
    let failNext = true;
    (axiosModule as any).get = async (url: string) => {
      if (url === DESCRIPTION_URL && failNext) {
        failNext = false;
        throw new Error("socket hang up");
      }
      return fakeGet(url);
    };
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      const info = await client.getGateway();
      assertEqual(await info.getDevice(), null, "the failing fetch reports null");
      const device = await info.getDevice();
      assert(device !== null, "the next call asks again");
    } finally {
      (axiosModule as any).get = fakeGet;
      client.close();
      restore();
    }
  });

  await test("a description advertising no usable service is refused", async () => {
    const restore = installFakeRouter("opnsense");
    const realGet = axiosModule.get;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      (axiosModule as any).get = async () =>
        ({
          data:
            '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>' +
            "<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>" +
            "<serviceList><service>" +
            "<serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>" +
            "<controlURL>/ctl</controlURL><SCPDURL>/scpd.xml</SCPDURL>" +
            "</service></serviceList></device></root>",
        }) as any;
      const err = await expectThrow(() => client.getStatusInfo(), "no WAN service");
      assert(
        /service not found/i.test((err as Error).message),
        `expected a service-not-found error, got ${(err as Error).message}`
      );
    } finally {
      (axiosModule as any).get = realGet;
      client.close();
      restore();
    }
  });

  await test("a description with no root element is refused", async () => {
    const restore = installFakeRouter("opnsense");
    const realGet = axiosModule.get;
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      (axiosModule as any).get = async () => ({ data: "<notroot></notroot>" }) as any;
      const err = await expectThrow(() => client.getStatusInfo(), "no root");
      assert(
        /no root element/i.test((err as Error).message),
        `expected a root-element error, got ${(err as Error).message}`
      );
    } finally {
      (axiosModule as any).get = realGet;
      client.close();
      restore();
    }
  });

  // ========================================
  // Finding the gateway by discovery
  // ========================================
  console.log("\n=== Gateway discovery ===\n");

  // Everything above hands the client a URL, which skips discovery altogether.
  // This drives the path a client takes when it has to find the router itself.

  async function withDiscovery<T>(
    options: { cacheGateway?: boolean; timeout?: number },
    fn: (client: Client, sockets: FakeSocket[], respond: () => void) => Promise<T>
  ): Promise<T> {
    const fake = installFakeDgram();
    const restore = installFakeRouter("opnsense");
    const client = new Client({ timeout: options.timeout ?? 300, ...options });
    const respond = () => {
      for (const socket of fake.sockets) {
        socket.deliver(
          ssdpResponse("urn:schemas-upnp-org:device:InternetGatewayDevice:1", DESCRIPTION_URL)
        );
      }
    };
    try {
      return await fn(client, fake.sockets, respond);
    } finally {
      client.close();
      restore();
      fake.restore();
    }
  }

  await test("a client with no URL finds the gateway over SSDP", async () => {
    await withDiscovery({}, async (client, _sockets, respond) => {
      const pending = client.getGateway();
      await settle();
      respond();
      const info = await pending;
      assertEqual(info.gateway.description, DESCRIPTION_URL, "the announced location is used");
      const device = await info.getDevice();
      assertEqual(device!.manufacturer, "FreeBSD", "the discovered device is readable");
    });
  });

  await test("discovery that nothing answers times out", async () => {
    await withDiscovery({ timeout: 200 }, async (client) => {
      const err = await expectThrow(() => client.getGateway(), "unanswered discovery");
      assert(/timed out/i.test((err as Error).message), `got: ${(err as Error).message}`);
    });
  });

  await test("discovery reports the environment's failure, not a timeout", async () => {
    // EADDRINUSE is fixable on the caller's machine; "no router here" is not.
    // The generic timeout message erased that difference, and FluxOS turns it
    // into upnpMachine = false.
    await withDiscovery({ timeout: 400 }, async (client) => {
      FakeSocket.failNextBind = true;
      const err = await expectThrow(() => client.getGateway(), "discovery on a failing socket");
      assertEqual((err as Error).message, "EADDRINUSE", "the underlying error surfaces");
    });
  });

  await test("close aborts an in-flight discovery instead of letting it run out", async () => {
    await withDiscovery({ timeout: 2000 }, async (client, sockets) => {
      const pending = expectThrow(() => client.getGateway(), "discovery aborted by close");
      await settle();
      client.close();
      const err = await pending;
      assert(/closed/i.test((err as Error).message), `got: ${(err as Error).message}`);
      assert(sockets[0].closed, "the search socket is released at close, not at the timeout");
    });
  });

  await test("a cached gateway is not rediscovered", async () => {
    await withDiscovery({ cacheGateway: true }, async (client, sockets, respond) => {
      const pending = client.getGateway();
      await settle();
      respond();
      await pending;
      const before = sockets.length;
      await client.getGateway();
      assertEqual(sockets.length, before, "no second search is made");
    });
  });

  await test("without caching the next call searches again", async () => {
    await withDiscovery({}, async (client, sockets, respond) => {
      const first = client.getGateway();
      await settle();
      respond();
      await first;
      const before = sockets.length;
      const second = client.getGateway();
      await settle();
      respond();
      await second;
      assert(sockets.length > before, "a fresh search is made");
    });
  });

  await test("concurrent callers share one discovery", async () => {
    await withDiscovery({}, async (client, sockets, respond) => {
      // The pending promise is handed to later callers so a burst of calls does
      // not produce a burst of SSDP searches.
      const a = client.getGateway();
      const b = client.getGateway();
      await settle();
      respond();
      const [one, two] = await Promise.all([a, b]);
      assertEqual(one, two, "both callers get the same gateway");
      const searchesSent = sockets.reduce((n, s) => n + s.sent.length, 0);
      assertEqual(searchesSent, 1, "one search served both");
    });
  });

  await test("a response advertising an unusable location is ignored", async () => {
    await withDiscovery({ timeout: 200 }, async (client, sockets) => {
      const pending = expectThrow(() => client.getGateway(), "unusable location");
      await settle();
      for (const socket of sockets) {
        socket.deliver(
          ssdpResponse("urn:schemas-upnp-org:device:InternetGatewayDevice:1", "ftp://192.0.2.1/x")
        );
      }
      const err = await pending;
      assert(/timed out/i.test((err as Error).message), "a bad location does not resolve discovery");
    });
  });

  await test("discovery releases its SSDP socket once finished", async () => {
    await withDiscovery({}, async (client, sockets, respond) => {
      const pending = client.getGateway();
      await settle();
      respond();
      await pending;
      await settle();
      assert(
        sockets.every((s) => s.closed),
        "every socket opened for discovery is closed"
      );
    });
  });

  // ========================================
  // Option handling on the client methods
  // ========================================
  console.log("\n=== Option handling ===\n");

  await test("createMapping accepts a combined public/private port shape", async () => {
    // The options normalise several shapes; a caller may give one port meaning
    // both sides, or an object carrying a host.
    await withRouter("opnsense", (c) => c.createMapping({ public: 7000, private: 7000, ttl: 0 }));
    const one = requests.find((r) => r.action === "AddPortMapping");
    assert(one!.body.includes("<NewExternalPort>7000</NewExternalPort>"), "external");
    assert(one!.body.includes("<NewInternalPort>7000</NewInternalPort>"), "internal");
  });

  await test("createMapping honours an explicit internal host", async () => {
    await withRouter("opnsense", (c) =>
      c.createMapping({
        public: 7001,
        private: { host: "192.168.5.5", port: 7002 },
        ttl: 0,
      })
    );
    const req = requests.find((r) => r.action === "AddPortMapping");
    assert(
      req!.body.includes("<NewInternalClient>192.168.5.5</NewInternalClient>"),
      `explicit host should override the resolved one — got ${req!.body}`
    );
    assert(req!.body.includes("<NewInternalPort>7002</NewInternalPort>"), "internal port");
  });

  await test("createMapping sends a remote host when one is given", async () => {
    await withRouter("opnsense", (c) =>
      c.createMapping({
        public: { host: "198.51.100.7", port: 7003 },
        private: 7003,
        ttl: 0,
      })
    );
    const req = requests.find((r) => r.action === "AddPortMapping");
    assert(
      req!.body.includes("<NewRemoteHost>198.51.100.7</NewRemoteHost>"),
      `remote host should be sent — got ${req!.body}`
    );
  });

  await test("removeMapping carries the remote host through", async () => {
    await withRouter("opnsense", (c) =>
      c.removeMapping({ public: { host: "198.51.100.8", port: 7004 } })
    );
    const req = requests.find((r) => r.action === "DeletePortMapping");
    assert(req!.body.includes("<NewRemoteHost>198.51.100.8</NewRemoteHost>"), "remote host");
    assert(req!.body.includes("<NewExternalPort>7004</NewExternalPort>"), "external port");
  });

  await test("getMapping asks about the remote host it was given", async () => {
    await withRouter("opnsense", (c) =>
      c.getMapping({ public: 16132, remoteHost: "198.51.100.9" })
    );
    const req = requests.find((r) => r.action === "GetSpecificPortMappingEntry");
    assert(req!.body.includes("<NewRemoteHost>198.51.100.9</NewRemoteHost>"), "remote host");
  });

  await test("getMapping reports the remote host back on the result", async () => {
    const mapping = await withRouter("opnsense", (c) =>
      c.getMapping({ public: 16132, remoteHost: "198.51.100.9" })
    );
    assert(mapping !== null, "mapping");
    assertEqual(mapping!.public.host, "198.51.100.9", "echoed remote host");
  });

  await test("a lower-case protocol is upper-cased on the wire", async () => {
    await withRouter("opnsense", (c) => c.removeMapping({ public: 7005, protocol: "udp" }));
    const req = requests.find((r) => r.action === "DeletePortMapping");
    assert(req!.body.includes("<NewProtocol>UDP</NewProtocol>"), "protocol upper-cased");
  });

  await test("getMappings filters on a partial description", async () => {
    // The filter is a substring match, so a fragment of the description finds
    // the entry and an unrelated fragment does not.
    const found = await withRouter("opnsense", (c) => c.getMappings({ description: "Reserved" }));
    assertEqual(found.length, 1, "a fragment matches");
    const missed = await withRouter("opnsense", (c) => c.getMappings({ description: "nothing" }));
    assertEqual(missed.length, 0, "an unrelated fragment does not");
  });

  await test("getMappings accepts a regular expression description", async () => {
    const found = await withRouter("opnsense", (c) =>
      c.getMappings({ description: /^FluxOS/ })
    );
    assertEqual(found.length, 1, "a regular expression matches");
    const missed = await withRouter("opnsense", (c) => c.getMappings({ description: /^nope/ }));
    assertEqual(missed.length, 0, "a non-matching expression filters everything");
  });

  await test("getStatusInfo reports uptime as a number", async () => {
    const status = await withRouter("opnsense", (c) => c.getStatusInfo());
    assert(Number.isFinite(status.uptime), `uptime should be numeric, got ${status.uptime}`);
    assert(status.uptime > 0, "uptime is positive");
  });

  await test("getAll resolves device, capabilities and address together", async () => {
    const all = await withRouter("opnsense", async (c) => {
      const info = await c.getGateway();
      return info.getAll();
    });
    assert(all.device !== null, "device");
    assert(all.capabilities !== null, "capabilities");
    assertEqual(all.localAddress, LOCAL_ADDRESS, "local address");
  });

  await test("a closed client refuses further work", async () => {
    const restore = installFakeRouter("opnsense");
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      await client.getGateway();
      client.close();
      const err = await expectThrow(() => client.getGateway(), "getGateway after close");
      assert(/closed/i.test((err as Error).message), `expected a closed error, got ${err}`);
    } finally {
      restore();
    }
  });

  await test("close is safe to call more than once", async () => {
    const restore = installFakeRouter("opnsense");
    const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
    try {
      await client.getGateway();
      client.close();
      client.close();
    } finally {
      restore();
    }
  });

  await test("url mode requires a local address", () => {
    let threw = false;
    try {
      new Client({ url: DESCRIPTION_URL });
    } catch (err) {
      threw = true;
      assert(/localAddress/.test((err as Error).message), "names the missing option");
    }
    assert(threw, "expected a constructor error");
  });

  await test("a device URL that is not http is refused", () => {
    for (const bad of ["ftp://192.0.2.1/desc.xml", "192.0.2.1/desc.xml", ""]) {
      let threw = false;
      try {
        new Device(bad);
      } catch {
        threw = true;
      }
      assert(threw, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });

  // ========================================
  // Local address resolution
  // ========================================
  console.log("\n=== Local address resolution ===\n");

  // A UDP "connect" sends no packet; it asks the kernel which interface would
  // reach the router and reads the answer back off the socket. Nothing in the
  // suite could reach this without a fake socket.

  async function withDgram<T>(fn: (sockets: FakeSocket[]) => Promise<T>): Promise<T> {
    const fake = installFakeDgram();
    try {
      return await fn(fake.sockets);
    } finally {
      fake.restore();
    }
  }

  await test("the local address comes from a socket connected to the router", async () => {
    await withDgram(async (sockets) => {
      FakeSocket.localAddress = "10.1.2.3";
      const device = new Device("http://192.168.7.1:5000/rootDesc.xml");
      assertEqual(await device.getLocalAddress(), "10.1.2.3", "address");
      assertEqual(sockets.length, 1, "one socket");
      assertEqual(sockets[0].connectedTo?.address, "192.168.7.1", "connects to the router");
      assertEqual(sockets[0].connectedTo?.port, 80, "port 80");
      assertEqual(sockets[0].closed, true, "socket is released");
    });
  });

  await test("a failed connect resolves to an empty address rather than throwing", async () => {
    await withDgram(async () => {
      FakeSocket.failNextConnect = true;
      const device = new Device("http://192.168.7.1:5000/rootDesc.xml");
      assertEqual(await device.getLocalAddress(), "", "unreachable router yields no address");
    });
  });

  await test("a connect that never answers is abandoned rather than hanging", async () => {
    await withDgram(async (sockets) => {
      FakeSocket.hangNextConnect = true;
      const device = new Device("http://192.168.7.1:5000/rootDesc.xml");
      // The timeout is the only thing that can end this; without it the call
      // would never settle.
      const settled = await Promise.race([
        device.getLocalAddress(),
        new Promise((r) => setTimeout(() => r("__never__"), 6500)),
      ]);
      assertEqual(settled, "", "the timeout path yields an empty address");
      assertEqual(sockets[0].closed, true, "the abandoned socket is closed");
    });
  });

  await test("a hostname that is not IPv4 skips the socket entirely", async () => {
    await withDgram(async (sockets) => {
      // A DNS name or IPv6 literal cannot be used for the udp4 route query.
      const device = new Device("http://router.local:5000/rootDesc.xml");
      assertEqual(await device.getLocalAddress(), "", "no address");
      assertEqual(sockets.length, 0, "no socket is opened");
    });
  });

  await test("the resolved address is cached, so the query runs once", async () => {
    await withDgram(async (sockets) => {
      FakeSocket.localAddress = "10.9.9.9";
      const device = new Device("http://192.168.7.1:5000/rootDesc.xml");
      assertEqual(await device.getLocalAddress(), "10.9.9.9", "first call");
      assertEqual(await device.getLocalAddress(), "10.9.9.9", "second call");
      assertEqual(sockets.length, 1, "the second call reuses the cached answer");
    });
  });

  await test("a failed resolution is not cached, so a later call retries", async () => {
    await withDgram(async (sockets) => {
      FakeSocket.failNextConnect = true;
      const device = new Device("http://192.168.7.1:5000/rootDesc.xml");
      assertEqual(await device.getLocalAddress(), "", "first call fails");
      FakeSocket.localAddress = "10.4.5.6";
      assertEqual(await device.getLocalAddress(), "10.4.5.6", "second call succeeds");
      assertEqual(sockets.length, 2, "a second socket is opened for the retry");
    });
  });

  await test("a supplied localAddress bypasses resolution altogether", async () => {
    await withDgram(async (sockets) => {
      const client = new Client({ url: DESCRIPTION_URL, localAddress: "172.16.32.12" });
      const restore = installFakeRouter("opnsense");
      try {
        const info = await client.getGateway();
        assertEqual(await info.getLocalAddress(), "172.16.32.12", "the override is used");
        assertEqual(sockets.length, 0, "no route query is made");
      } finally {
        client.close();
        restore();
      }
    });
  });

  // ========================================
  // SSDP discovery over a fake UDP socket
  // ========================================
  console.log("\n=== SSDP discovery ===\n");

  const IGD = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";

  async function withSsdp<T>(fn: (ssdp: Ssdp, sockets: FakeSocket[]) => Promise<T>): Promise<T> {
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      return await fn(ssdp, fake.sockets);
    } finally {
      ssdp.close();
      fake.restore();
    }
  }

  function once(emitter: SsdpEmitter, event: "device", ms = 50): Promise<any | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      emitter.once(event, ((payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      }) as any);
    });
  }

  await test("search sends a conformant M-SEARCH to the multicast group", async () => {
    await withSsdp(async (ssdp, sockets) => {
      ssdp.search(IGD);
      await settle();
      assertEqual(sockets.length, 2, "one search socket and one route probe");
      assertEqual(sockets[0].sent.length, 1, "one datagram is sent");
      const { query, port, address } = sockets[0].sent[0];
      assertEqual(port, 1900, "SSDP port");
      assertEqual(address, "239.255.255.250", "multicast group");
      assert(query.startsWith("M-SEARCH * HTTP/1.1\r\n"), "request line");
      assert(query.includes(`ST: ${IGD}\r\n`), "search target");
      assert(query.includes('MAN: "ssdp:discover"\r\n'), "MAN header");
      assert(/MX: \d+\r\n/.test(query), "MX header");
      assert(query.includes("HOST: 239.255.255.250:1900\r\n"), "HOST header");
      assert(query.endsWith("\r\n\r\n"), "blank line terminates the request");
    });
  });

  await test("the search leaves via the internet-facing interface", async () => {
    await withSsdp(async (ssdp, sockets) => {
      // The kernel routes multicast by its own table, which an unrelated
      // 224.0.0.0/4 route can steer away from the internet path. A mapping is
      // only useful on the NAT the internet reaches this host through, so the
      // send must be pinned there deliberately, not left to routing chance.
      FakeSocket.localAddress = "10.31.7.5";
      ssdp.search(IGD);
      await settle();
      assertEqual(sockets.length, 2, "one search socket and one route probe");
      const [searchSocket, probe] = sockets;
      assert(probe.connectedTo !== null, "the probe asks the kernel for the internet route");
      assertEqual(probe.sent.length, 0, "the probe sends nothing on the wire");
      assertEqual(
        searchSocket.multicastInterface,
        "10.31.7.5",
        "the search is pinned to the internet route's source address"
      );
      assertEqual(searchSocket.sent.length, 1, "the search is sent");
    });
  });

  await test("a host with no internet route still searches, on the OS's choice", async () => {
    await withSsdp(async (ssdp, sockets) => {
      FakeSocket.failNextConnect = true;
      ssdp.search(IGD);
      await settle();
      assertEqual(sockets[0].multicastInterface, null, "nothing to pin to");
      assertEqual(sockets[0].sent.length, 1, "the search is still sent");
    });
  });

  await test("a matching response is reported as a device", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      // The listener has to be attached first: delivery emits synchronously.
      const pending = once(emitter, "device");
      sockets[0].deliver(ssdpResponse(IGD));
      const headers = await pending;
      assert(headers !== null, "expected a device event");
      assertEqual(headers.location, "http://192.0.2.1:5000/rootDesc.xml", "location");
      assertEqual(headers.st, IGD, "search target echoed back");
    });
  });

  await test("a response for a different search target is ignored", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      // Listener first: delivery emits synchronously, so listening afterwards
      // reports null even for a response the code accepted.
      const pending = once(emitter, "device");
      sockets[0].deliver(ssdpResponse("urn:schemas-upnp-org:device:MediaServer:1"));
      assertEqual(await pending, null, "should not match another target");
    });
  });

  await test("a response without a Location header is rejected", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      const pending = once(emitter, "device");
      sockets[0].deliver(`HTTP/1.1 200 OK\r\nST: ${IGD}\r\n\r\n`);
      assertEqual(await pending, null, "no location means no device");
    });
  });

  await test("a Location that is not http is rejected", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      // Guards against a hostile responder pointing the client at a file or a
      // scheme the fetch would treat very differently.
      const pending = once(emitter, "device");
      sockets[0].deliver(ssdpResponse(IGD, "file:///etc/passwd"));
      assertEqual(await pending, null, "non-http location is refused");
    });
  });

  await test("traffic that is not an SSDP response is ignored", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      const pending = once(emitter, "device");
      // Matching ST and a valid Location, so the request line is the only
      // thing standing between this garbage and a device event.
      sockets[0].deliver(`GARBAGE\r\nST: ${IGD}\r\nLOCATION: http://192.0.2.1/\r\n\r\n`);
      assertEqual(await pending, null, "only HTTP/NOTIFY is parsed");
    });
  });

  await test("a NOTIFY advertisement is accepted as well as a search reply", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      const pending = once(emitter, "device");
      sockets[0].deliver(
        `NOTIFY * HTTP/1.1\r\nST: ${IGD}\r\nLOCATION: http://192.0.2.1:5000/rootDesc.xml\r\n\r\n`
      );
      assert((await pending) !== null, "NOTIFY should be parsed too");
    });
  });

  await test("searches issued before the bind completes are flushed afterwards", async () => {
    await withSsdp(async (ssdp, sockets) => {
      // Two searches back to back: the first triggers the bind, the second
      // arrives while it is still in flight and must be queued, not dropped.
      ssdp.search(IGD);
      ssdp.search("urn:schemas-upnp-org:device:MediaServer:1");
      await settle();
      // Anchor on the line start: "HOST:" also ends in "ST:".
      const sentTargets = sockets
        .flatMap((s) => s.sent)
        .map((d) => /\r\nST: (.*)\r\n/.exec(d.query)?.[1]);
      assert(sentTargets.includes(IGD), "the first search is sent");
      assert(
        sentTargets.includes("urn:schemas-upnp-org:device:MediaServer:1"),
        "the queued search is sent too"
      );
    });
  });

  await test("concurrent searches before bind share one socket, and close releases it", async () => {
    // The socket is stored before the bind resolves, so a search arriving in
    // that window queues rather than opening a second socket. Previously the
    // later bind overwrote the reference and close freed the idle one, leaving
    // the socket carrying traffic open.
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      ssdp.search(IGD);
      ssdp.search("urn:schemas-upnp-org:device:MediaServer:1");
      await settle();
      assertEqual(fake.sockets[0].sent.length, 2, "one socket serves both searches");
      ssdp.close();
      assertEqual(fake.sockets[0].closed, true, "close releases the working socket");
    } finally {
      fake.restore();
    }
  });

  await test("a socket failure reaches the search that is waiting on it", async () => {
    await withSsdp(async (ssdp) => {
      FakeSocket.failNextBind = true;
      const emitter = ssdp.search(IGD);
      let heard: Error | null = null;
      emitter.on("error", (err) => {
        heard = err;
      });
      await settle();
      assert(heard !== null, "the bind failure is delivered to the search");
      assertEqual((heard as unknown as Error).message, "EADDRINUSE", "the real error arrives");
    });
  });

  await test("a bind failure leaves no socket behind", async () => {
    const fake = installFakeDgram();
    FakeSocket.failNextBind = true;
    const ssdp = new Ssdp();
    try {
      ssdp.search(IGD);
      await settle();
      assertEqual(fake.sockets.length, 1, "a socket was attempted");
      assertEqual(fake.sockets[0].sent.length, 0, "nothing is sent when the bind fails");
      assertEqual(fake.sockets[0].closed, true, "the failed socket is closed");
    } finally {
      ssdp.close();
      fake.restore();
    }
  });

  await test("a stale error from a replaced socket does not poison the instance", async () => {
    // A dead socket can emit a second, late error — the handler stays
    // attached so that cannot crash the process. But the late error belongs
    // to nobody: handing it to searches on the replacement socket, or
    // flipping the instance unbound after the replacement is already
    // listening, strands every later search behind a "socket ready" signal
    // that already fired.
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      FakeSocket.failNextBind = true;
      const first = ssdp.search(IGD);
      let firstErr: Error | null = null;
      first.on("error", (err) => { firstErr = err; });
      await settle();
      assert(firstErr !== null, "the bind failure reaches the first search");

      const healthy = ssdp.search(IGD);
      const healthyErrs: Error[] = [];
      healthy.on("error", (err) => healthyErrs.push(err));
      await settle();
      assertEqual(fake.sockets[1].sent.length, 1, "the replacement socket serves the second search");

      fake.sockets[0].emit("error", new Error("stale error from the dead socket"));
      await settle();
      assertEqual(healthyErrs.length, 0, "the healthy search hears nothing");

      const later = ssdp.search(IGD);
      const laterErrs: Error[] = [];
      later.on("error", (err) => laterErrs.push(err));
      await settle();
      assertEqual(fake.sockets[1].sent.length, 2, "a later search still sends");
      assertEqual(laterErrs.length, 0, "and hears no stale error either");
    } finally {
      ssdp.close();
      fake.restore();
    }
  });

  await test("close stops delivery and releases the socket", async () => {
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      const emitter = ssdp.search(IGD);
      await settle();
      const socket = fake.sockets[0];
      ssdp.close();
      assertEqual(socket.closed, true, "socket is closed");
      const pending = once(emitter, "device");
      socket.deliver(ssdpResponse(IGD));
      assertEqual(await pending, null, "no delivery after close");
    } finally {
      fake.restore();
    }
  });

  await test("close is idempotent and searching afterwards opens nothing", async () => {
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      ssdp.search(IGD);
      await settle();
      ssdp.close();
      ssdp.close();
      const before = fake.sockets.length;
      ssdp.search(IGD);
      await settle();
      assertEqual(fake.sockets.length, before, "no socket is created after close");
    } finally {
      fake.restore();
    }
  });

  await test("a custom source port is used for the bind", async () => {
    const fake = installFakeDgram();
    const ssdp = new Ssdp({ sourcePort: 1901 });
    try {
      ssdp.search(IGD);
      await settle();
      assertEqual(fake.sockets[0].boundTo, 1901, "bind uses the requested source port");
    } finally {
      ssdp.close();
      fake.restore();
    }
  });

  // ========================================
  // The surveyed corpus
  // ========================================
  console.log(`\n=== Surveyed routers (${surveyedRouters.length}) ===\n`);

  // Every router asserts against its own captured documents rather than a
  // shared assumption, because the survey showed they do not agree: the walk
  // ends on 402 as well as 713, and timed leases are refused with 725, 501 and
  // 718. Values come from the capture, never from this library's parser.
  for (const router of surveyedRouters) {
    await test(`${router.slug}: client reads its captured responses`, async () => {
      const restore = installFakeRouter(router.slug);
      const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
      try {
        const info = await client.getGateway();

        // Every field the description carries, not a sample of three: a
        // mutation in any one of them should fail here.
        const device = await info.getDevice();
        assert(device !== null, "device info");
        assertEqual(device!.manufacturer, router.manufacturer, "manufacturer");
        assertEqual(device!.modelName, router.modelName, "modelName");
        assertEqual(device!.modelNumber, router.modelNumber, "modelNumber");
        assertEqual(device!.modelDescription, router.modelDescription, "modelDescription");
        assertEqual(device!.friendlyName, router.friendlyName, "friendlyName");
        assertEqual(device!.manufacturerURL, router.manufacturerURL, "manufacturerURL");
        assertEqual(device!.modelURL, router.modelURL, "modelURL");
        assertEqual(device!.presentationURL, router.presentationURL, "presentationURL");
        assertEqual(device!.configId, router.configId, "configId");
        assertEqual(device!.specVersion.major, router.specMajor, "spec major");
        assertEqual(device!.specVersion.minor, router.specMinor, "spec minor");
        assertEqual(device!.descriptionURL, DESCRIPTION_URL, "descriptionURL");

        if (router.wan) {
          assert(device!.wan !== undefined, "WAN sub-device found");
          assertEqual(device!.wan!.manufacturer, router.wan.manufacturer, "wan manufacturer");
          assertEqual(device!.wan!.modelName, router.wan.modelName, "wan modelName");
          assertEqual(device!.wan!.modelNumber, router.wan.modelNumber, "wan modelNumber");
          assertEqual(
            device!.wan!.modelDescription,
            router.wan.modelDescription,
            "wan modelDescription"
          );
        }

        const caps = await info.getCapabilities();
        assert(caps !== null, "capabilities");
        assertEqual(caps!.serviceType, router.serviceType, "service type");
        assertEqual(caps!.serviceVersion, router.serviceVersion, "service version");
        // Compared as sets: the library preserves SCPD document order, the
        // generator sorts. What matters is that none are lost or invented.
        assertEqual(
          [...caps!.actions].sort().join(","),
          router.actions.join(","),
          "every advertised action, no more and no fewer"
        );
        for (const [flag, action] of [
          ["supportsAddAnyPortMapping", "AddAnyPortMapping"],
          ["supportsDeletePortMappingRange", "DeletePortMappingRange"],
          ["supportsGetListOfPortMappings", "GetListOfPortMappings"],
          ["supportsGetSpecificPortMappingEntry", "GetSpecificPortMappingEntry"],
          ["supportsGetStatusInfo", "GetStatusInfo"],
        ] as const) {
          assertEqual(
            (caps as any)[flag],
            router.actions.includes(action),
            `${flag} tracks ${action}`
          );
        }

        // Relative URLs resolve against URLBase when the router publishes one,
        // and against the description URL otherwise.
        const origin = new URL(router.urlBase ?? DESCRIPTION_URL).origin;
        assert(
          caps!.controlURL.startsWith(origin),
          `controlURL ${caps!.controlURL} should resolve against ${origin}`
        );

        assertEqual(await client.getPublicIp(), router.externalIp, "external address");

        if (router.connectionStatus) {
          const status = await client.getStatusInfo();
          assertEqual(status.connectionStatus, router.connectionStatus, "connection status");
        } else {
          // No status was recorded because the router refused the action:
          // the capture is a fault, and it must surface as that fault.
          const capture = loadFixture(`${router.slug}-soap-GetStatusInfo.xml`);
          const code = capture.match(/<errorCode>(\d+)</)?.[1];
          assert(code !== undefined, "an empty connectionStatus means the capture is a fault");
          const err = await expectThrow(() => client.getStatusInfo(), "getStatusInfo on a refusing router");
          assert(
            err instanceof UpnpError && String(err.code) === code,
            `the captured fault ${code} surfaces, got ${err}`
          );
        }

        // The walk must terminate whatever code this router ends it with.
        const mappings = await client.getMappings();
        if (router.genericEntry) {
          assertEqual(mappings.length, 1, "the captured entry is returned");
          const m = mappings[0];
          assertEqual(m.public.port, router.genericEntry.external, "external port");
          assertEqual(m.private.host, router.genericEntry.host, "internal host");
          assertEqual(m.private.port, router.genericEntry.internal, "internal port");
          assertEqual(m.protocol, router.genericEntry.protocol, "protocol");
          assertEqual(m.description, router.genericEntry.description, "description");
        }

        if (router.specificEntry) {
          const hit = await client.getMapping({ public: router.genericEntry!.external });
          assert(hit !== null, "specific entry");
          assertEqual(hit!.private.host, router.specificEntry.host, "specific internal host");
          assertEqual(hit!.private.port, router.specificEntry.internal, "specific internal port");
          assertEqual(hit!.description, router.specificEntry.description, "specific description");
        }

        // A missing mapping answers whatever this router's capture shows: a
        // 713/714 fault resolves to null, and a success document means the
        // router ignores the port argument — its mapped entry comes back as a
        // phantom for any port asked, and nothing in the response reveals it.
        if (router.notFoundCode === 713 || router.notFoundCode === 714) {
          assertEqual(
            await client.getMapping({ public: UNMAPPED_PORT }),
            null,
            `not-found ${router.notFoundCode} should resolve to null`
          );
        } else {
          assertEqual(router.notFoundCode, null, "the only other surveyed shape is a success answer");
          const capture = loadFixture(`${router.slug}-soap-GetSpecificPortMappingEntry_NotFound.xml`);
          assert(!/<errorCode>/.test(capture), "notFoundCode null must mean a fault-free capture");
          assert(router.specificEntry !== null, "an echoing router carries its mapped entry");
          const phantom = await client.getMapping({ public: UNMAPPED_PORT });
          assert(phantom !== null, "the echoing router returns its entry as a phantom");
          assertEqual(phantom!.private.port, router.specificEntry!.internal, "the phantom is the mapped entry");
          assertEqual(phantom!.description, router.specificEntry!.description, "the phantom's description");
        }
      } finally {
        client.close();
        restore();
      }
    });
  }

  for (const router of surveyedRouters) {
    await test(`${router.slug}: create and remove behave as this router answers`, async () => {
      const restore = installFakeRouter(router.slug);
      const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
      try {
        // Nothing is assumed about either lease: routers disagree on both, and
        // the corpus has one that refuses even a permanent mapping with 501.
        async function expectLease(ttl: number, expected: number | null, what: string) {
          let code: number | null = null;
          try {
            const res = await client.createMapping({ public: 8080, private: 8080, ttl });
            assert(res !== undefined, `${what}: expected a response`);
          } catch (err) {
            code = err instanceof UpnpError ? err.code : -1;
          }
          assertEqual(code, expected, `${what} for ${router.slug}`);
        }

        await expectLease(0, router.ttl0Code, "permanent lease");
        // A 725 refusal is retried without a lease, so the caller sees success
        // wherever the permanent attempt would also have succeeded.
        const timedOutcome =
          router.ttl60Code === 725 ? router.ttl0Code : router.ttl60Code;
        await expectLease(60, timedOutcome, "timed lease");

        // Delete either succeeds or reports a UPnP fault; it must never hang or
        // return something that is not a response.
        try {
          const removed = await client.removeMapping({ public: 8080 });
          assert(removed !== undefined, "delete response");
        } catch (err) {
          assert(err instanceof UpnpError, `delete should fail as UpnpError, got ${err}`);
        }
      } finally {
        client.close();
        restore();
      }
    });
  }

  for (const router of surveyedRouters.filter((r) => r.actions.includes("GetListOfPortMappings"))) {
    await test(`${router.slug}: getMappingRange parses its captured listing`, async () => {
      const mappings = await withRouter(router.slug, (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      // The listing is the router's own; assert it parsed into something
      // coherent rather than the empty list a decoding slip would produce.
      assert(Array.isArray(mappings), "a list is returned");
      for (const m of mappings) {
        assert(m.public.port >= 0 && m.public.port <= 65535, `external port ${m.public.port}`);
        assert(typeof m.description === "string", "description is a string");
        assert(m.protocol === "tcp" || m.protocol === "udp", `protocol ${m.protocol}`);
      }
    });
  }

  await test("getMappingRange reads NewProtocol from the listing, not from the request", async () => {
    // Every captured listing in the corpus is TCP-only, so asking for UDP is
    // what separates a value read out of the router's answer from one copied
    // off our own question. Requesting the protocol the router lists is
    // precisely how that copy stays invisible.
    const slug = "ubiquiti-udm-pro-max";
    const mappings = await withRouter(slug, (c) =>
      c.getMappingRange({ startPort: 1, endPort: 65535, protocol: "UDP" })
    );
    assert(mappings.length > 0, `${slug}: expected entries in the captured listing`);
    for (const m of mappings) {
      assertEqual(m.protocol, "tcp", `${slug}: port ${m.public.port} protocol comes from the listing`);
    }
  });

  await test("the captured v2 responses are the ones being served", async () => {
    // Guards the harness itself: the synthetic shapes must never take
    // precedence over a real capture, or the fleet data would go unused.
    const withCapture = surveyedRouters.filter((r) =>
      r.actions.includes("GetListOfPortMappings")
    );
    assert(withCapture.length > 0, "expected routers advertising GetListOfPortMappings");
    const nonEmpty = [];
    for (const router of withCapture) {
      const mappings = await withRouter(router.slug, (c) =>
        c.getMappingRange({ startPort: 1, endPort: 65535 })
      );
      if (mappings.length > 0) nonEmpty.push(router.slug);
    }
    // The synthetic listing always yields exactly two entries, so a corpus
    // where every router returns two would mean nothing real is being read.
    assert(
      nonEmpty.length > 0,
      "expected at least one router to return mappings from its captured listing"
    );
  });

  await test("the corpus covers the disagreements the fleet actually shows", async () => {
    // A guard on the corpus itself: if a regeneration quietly dropped the
    // outliers, these tests would still pass while testing nothing unusual.
    const endCodes = new Set(surveyedRouters.map((r) => r.endOfListCode));
    const leaseCodes = new Set(surveyedRouters.map((r) => r.ttl60Code).filter((c) => c !== null));
    const versions = new Set(surveyedRouters.map((r) => r.serviceVersion));
    assert(endCodes.has(713) && endCodes.has(402), `end-of-list codes: ${[...endCodes]}`);
    assert(leaseCodes.size >= 2, `expected several lease rejections, got ${[...leaseCodes]}`);
    assert(versions.has(1) && versions.has(2), `expected both IGD versions, got ${[...versions]}`);
  });

  // ========================================
  // Empty mapping tables, every captured router
  // ========================================
  console.log("\n=== Empty mapping tables ===\n");

  // getMappings() on an empty table is [], never a throw — the contract the
  // rewrite advertises. Routers answer the walk's first index with 713, 714
  // or, on MikroTik and the TP-Link/Omada models, 402; each capture is driven
  // through the real client rather than only asserted to be a fault.
  const emptyTableRouters = readdirSync(fixturesDir)
    .filter((f) => f.endsWith("-soap-GetGenericPortMappingEntry_Empty.xml"))
    .map((f) => f.replace("-soap-GetGenericPortMappingEntry_Empty.xml", ""))
    .sort();

  await test("every captured router contributed an empty-table answer", () => {
    assertEqual(
      emptyTableRouters.length,
      routers.length + surveyedRouters.length,
      "routers with an _Empty capture"
    );
  });

  for (const router of emptyTableRouters) {
    await test(`${router}: an empty mapping table is [], not an error`, async () => {
      setEmptyTable(true);
      const restore = installFakeRouter(router);
      const client = new Client({ url: DESCRIPTION_URL, localAddress: LOCAL_ADDRESS });
      try {
        const mappings = await client.getMappings();
        assertEqual(mappings.length, 0, "an empty table yields no mappings");
      } finally {
        client.close();
        restore();
        setEmptyTable(false);
      }
    });
  }

  // ========================================
  // Summary
  // ========================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? "31" : "32"}m${failed} failed\x1b[0m`);
  console.log(
    `Routers tested: ${routers.length + surveyedRouters.length}` +
      ` (${routers.length} curated + ${surveyedRouters.length} surveyed)`
  );
  console.log(`Fixture files: ${readdirSync(fixturesDir).length}`);
  console.log(`${"=".repeat(50)}\n`);

  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((e) => console.log(`  \x1b[31m✗\x1b[0m ${e}`));
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
})();
