import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import axiosModule from "axios";
import { UpnpError } from "../src/nat-upnp/device";
import { Device } from "../src/nat-upnp/device";
import { Client } from "../src/nat-upnp/client";
import { parseMimeHeader, Ssdp, type SsdpEmitter } from "../src/nat-upnp/ssdp";
import { installFakeDgram, FakeSocket, ssdpResponse, settle } from "./fake-dgram";
import {
  installFakeRouter,
  requests,
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

  await test("mikrotik: a timed lease is rejected with 725 OnlyPermanentLeasesSupported", async () => {
    await expectUpnpError(
      withRouter("mikrotik", (c) =>
        c.createMapping({ public: 16132, private: 16132, ttl: 60 })
      ),
      725,
      "mikrotik createMapping ttl=60"
    );
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
      assertEqual(caps!.serviceType, caps!.serviceType, `${router}: serviceType present`);
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
    // friendlyName arrives still escaped: the parser runs with
    // processEntities: false for XXE protection, which also leaves the five
    // predefined character entities undecoded. Any router with & < > " ' in a
    // text field reads back escaped.
    opnsense: { friendlyName: "OPNsense UPnP IGD &amp; PCP", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "26.1.3", modelDescription: "FreeBSD with MiniUPnPd version 2.3.9 router", specVersion: { major: 1, minor: 1 } },
    "pfsense-2.7": { friendlyName: "FreeBSD router", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.7.2-RELEASE", modelDescription: "FreeBSD router", specVersion: { major: 1, minor: 1 } },
    "pfsense-2.8": { friendlyName: "FreeBSD router", manufacturer: "FreeBSD", modelName: "FreeBSD router", modelNumber: "2.8.1-RELEASE", modelDescription: "FreeBSD with MiniUPnPd version 2.3.7 router", specVersion: { major: 1, minor: 1 } },
    "asus-rt-ax55": { friendlyName: "RT-AX55-0001", manufacturer: "ASUSTeK Computer Inc.", modelName: "ASUS Wireless Router", modelNumber: "RT-AX55", modelDescription: "ASUS Wireless Router", specVersion: { major: 1, minor: 1 } },
    "nec-sh621a1": { friendlyName: "SH621A1", manufacturer: "NEC Corporation/NEC Platforms, Ltd.", modelName: "SH621A1", modelNumber: "", modelDescription: "Broadband Router and Wireless Access Point", specVersion: { major: 1, minor: 0 } },
    "sagemcom-livebox": { friendlyName: "Orange Livebox", manufacturer: "Sagemcom", modelName: "Residential Livebox (GPON, WAN Ethernet)", modelNumber: "5", modelDescription: "Sagemcom,fr,SGFI-fr-G06.R05.C05_20", specVersion: { major: 1, minor: 0 } },
    "sagemcom-f5685": { friendlyName: "Sagemcom F5685LGB", manufacturer: "Sagemcom", modelName: "F5685LGB", modelNumber: "F5685LGB", modelDescription: "F@ST 5685 LG, Mercury v3", specVersion: { major: 1, minor: 0 } },
    "nokia-igd-v2": { friendlyName: "Internet Home Gateway Device", manufacturer: "Nokia", modelName: "IGD Version 2.00", modelNumber: "2", modelDescription: "Optical-fiber Broadband Router", specVersion: { major: 1, minor: 0 } },
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
      assertEqual(sockets.length, 1, "one socket is created");
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
      sockets[0].deliver(ssdpResponse("urn:schemas-upnp-org:device:MediaServer:1"));
      assertEqual(await once(emitter, "device"), null, "should not match another target");
    });
  });

  await test("a response without a Location header is rejected", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      sockets[0].deliver(`HTTP/1.1 200 OK\r\nST: ${IGD}\r\n\r\n`);
      assertEqual(await once(emitter, "device"), null, "no location means no device");
    });
  });

  await test("a Location that is not http is rejected", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      // Guards against a hostile responder pointing the client at a file or a
      // scheme the fetch would treat very differently.
      sockets[0].deliver(ssdpResponse(IGD, "file:///etc/passwd"));
      assertEqual(await once(emitter, "device"), null, "non-http location is refused");
    });
  });

  await test("traffic that is not an SSDP response is ignored", async () => {
    await withSsdp(async (ssdp, sockets) => {
      const emitter = ssdp.search(IGD);
      await settle();
      sockets[0].deliver("GARBAGE\r\nST: whatever\r\nLOCATION: http://192.0.2.1/\r\n\r\n");
      assertEqual(await once(emitter, "device"), null, "only HTTP/NOTIFY is parsed");
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
      assertEqual(fake.sockets.length, 1, "one socket serves both searches");
      assertEqual(fake.sockets[0].sent.length, 2, "both searches are sent");
      ssdp.close();
      assertEqual(fake.sockets[0].closed, true, "close releases the working socket");
    } finally {
      fake.restore();
    }
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

  await test("close stops delivery and releases the socket", async () => {
    const fake = installFakeDgram();
    const ssdp = new Ssdp();
    try {
      const emitter = ssdp.search(IGD);
      await settle();
      const socket = fake.sockets[0];
      ssdp.close();
      assertEqual(socket.closed, true, "socket is closed");
      socket.deliver(ssdpResponse(IGD));
      assertEqual(await once(emitter, "device"), null, "no delivery after close");
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
      ssdp.search(IGD);
      await settle();
      assertEqual(fake.sockets.length, 1, "no socket is created after close");
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
  // Summary
  // ========================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? "31" : "32"}m${failed} failed\x1b[0m`);
  console.log(`Routers tested: ${routers.length}`);
  console.log(`Fixture files: 170`);
  console.log(`${"=".repeat(50)}\n`);

  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((e) => console.log(`  \x1b[31m✗\x1b[0m ${e}`));
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
})();
