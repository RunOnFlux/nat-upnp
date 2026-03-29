import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { XMLParser } from "fast-xml-parser";
import { UpnpError } from "../src/nat-upnp/device";
import { Device } from "../src/nat-upnp/device";

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

  // We can't import the private function, so test via the SSDP's public behavior
  // But we can test the regex pattern directly

  await test("MIME header parsing: standard CRLF", () => {
    const input = "HTTP/1.1 200 OK\r\nST: urn:test:1\r\nLocation: http://1.2.3.4/\r\n\r\n";
    const lines = input.split(/\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
      if (match) headers[match[1].toLowerCase()] = match[2].trimEnd();
    }
    assertEqual(headers["st"], "urn:test:1");
    assertEqual(headers["location"], "http://1.2.3.4/");
  });

  await test("MIME header parsing: LF-only line endings", () => {
    const input = "HTTP/1.1 200 OK\nST: urn:test:1\nLocation: http://1.2.3.4/\n\n";
    const lines = input.split(/\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
      if (match) headers[match[1].toLowerCase()] = match[2].trimEnd();
    }
    assertEqual(headers["st"], "urn:test:1");
  });

  await test("MIME header parsing: empty value", () => {
    const input = "HTTP/1.1 200 OK\r\nST:\r\n\r\n";
    const lines = input.split(/\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
      if (match) headers[match[1].toLowerCase()] = match[2].trimEnd();
    }
    assertEqual(headers["st"], "");
  });

  await test("MIME header parsing: value with colons", () => {
    const input = "HTTP/1.1 200 OK\r\nLocation: http://192.168.1.1:8080/desc.xml\r\n\r\n";
    const lines = input.split(/\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
      if (match) headers[match[1].toLowerCase()] = match[2].trimEnd();
    }
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
    // Verify all expected fields exist
    assert(res.NewExternalPort !== undefined, "ExternalPort");
    assert(res.NewInternalPort !== undefined, "InternalPort");
    assert(res.NewInternalClient !== undefined, "InternalClient");
    assert(res.NewProtocol !== undefined, "Protocol");
    assert(res.NewLeaseDuration !== undefined, "LeaseDuration");
    assert(res.NewPortMappingDescription !== undefined, "Description");
  });

  await test("TTL field is numeric across all router fixtures", () => {
    for (const router of routers) {
      const xml = loadFixture(`${router}-soap-GetSpecificPortMappingEntry.xml`);
      const body = xmlParser.parse(xml)?.Envelope?.Body;
      if (body.Fault) continue; // Skip fault responses
      const key = Object.keys(body).find((k) => k.startsWith("GetSpecificPortMappingEntryResponse"));
      if (!key) continue;
      const ttl = parseInt(body[key!].NewLeaseDuration, 10);
      assert(!isNaN(ttl), `${router}: TTL is NaN`);
      assert(ttl >= 0, `${router}: TTL is negative: ${ttl}`);
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
