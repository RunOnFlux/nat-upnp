import net from "net";
import { setupTest } from "./index.flux-test";
import { Client, Mapping, UpnpError } from "../src";
import { execSync } from "node:child_process";

setupTest("NAT-UPNP/Client", (opts) => {
  let client: Client;
  const globalPort: number[] = [];
  const localPort: number[] = [];
  for (let i = 0; i < 5; i++) {
    globalPort[i] = ~~(Math.random() * 10000 + 30000);
    localPort[i] = ~~(Math.random() * 1000 + 7000);
  }

  function iptablesPresent() {
    try {
      execSync("iptables --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  opts.runBefore(() => {
    client = new Client();
  });

  opts.runAfter(() => {
    client.close();
  });

  // ==========================================
  // Gateway discovery, device info, capabilities
  // ==========================================

  opts.run("Discover gateway and get device info", async () => {
    const info = await client.getGateway();
    const device = await info.getDevice();
    console.log("  Local address:", await info.getLocalAddress());
    console.log("  Description URL:", info.gateway.description);
    if (device) {
      console.log("  Manufacturer:", device.manufacturer);
      console.log("  Model:", device.modelName);
      console.log("  Model Number:", device.modelNumber);
      console.log("  Serial:", device.serialNumber);
      console.log("  Spec:", device.specVersion.major + "." + device.specVersion.minor);
      if (device.wan) {
        console.log("  WAN Daemon:", device.wan.modelDescription);
        console.log("  WAN Build:", device.wan.modelNumber);
      }
    }
    return (
      net.isIP(await info.getLocalAddress()) !== 0 &&
      !!device &&
      device.manufacturer.length > 0 &&
      info.gateway.description.startsWith("http")
    );
  });

  opts.run("Parse service capabilities from SCPD", async () => {
    const info = await client.getGateway();
    const capabilities = await info.getCapabilities();
    if (!capabilities) {
      console.log("  SCPD not available");
      return false;
    }
    console.log("  Service type:", capabilities.serviceType);
    console.log("  Service version:", capabilities.serviceVersion);
    console.log("  Actions:", capabilities.actions.join(", "));
    console.log("  v2 AddAnyPortMapping:", capabilities.supportsAddAnyPortMapping);
    console.log("  v2 DeletePortMappingRange:", capabilities.supportsDeletePortMappingRange);
    console.log("  v2 GetListOfPortMappings:", capabilities.supportsGetListOfPortMappings);
    console.log("  v1 GetSpecificPortMappingEntry:", capabilities.supportsGetSpecificPortMappingEntry);
    console.log("  v1 GetStatusInfo:", capabilities.supportsGetStatusInfo);
    return (
      capabilities.serviceType.includes("WANIPConnection") &&
      capabilities.serviceVersion >= 1 &&
      capabilities.actions.length > 0 &&
      capabilities.actions.includes("AddPortMapping") &&
      capabilities.actions.includes("DeletePortMapping") &&
      Array.isArray(capabilities.actions)
    );
  });

  opts.run("Gateway caching — second call is instant", async () => {
    // cacheGateway defaults to false, so the shared client would rediscover
    // over SSDP on every call and time the network rather than the cache.
    const cachingClient = new Client({ cacheGateway: true });
    try {
      await cachingClient.getGateway();
      const start = Date.now();
      await cachingClient.getGateway();
      const elapsed = Date.now() - start;
      console.log("  Second call took:", elapsed, "ms");
      return elapsed < 50;
    } finally {
      cachingClient.close();
    }
  });

  opts.run("Device info caching — second call is instant", async () => {
    const info = await client.getGateway();
    await info.getDevice(); // first call fetches
    const start = Date.now();
    await info.getDevice(); // second call cached
    const elapsed = Date.now() - start;
    console.log("  Second call took:", elapsed, "ms");
    return elapsed < 5;
  });

  // ==========================================
  // Basic v1 operations
  // ==========================================

  opts.run("Get public IP address", async () => {
    const ip = await client.getPublicIp();
    console.log("  Public IP:", ip);
    return net.isIP(ip) !== 0;
  });

  opts.run("Get status info (uptime)", async () => {
    const status = await client.getStatusInfo();
    console.log("  Status:", status.connectionStatus);
    console.log("  Uptime:", status.uptime, "seconds");
    console.log("  Last error:", status.lastConnectionError);
    return (
      typeof status.uptime === "number" &&
      status.uptime > 0 &&
      typeof status.connectionStatus === "string"
    );
  });

  opts.run("Display existing port mappings", async () => {
    const mappings = await client.getMappings();
    console.log("  Total mappings:", mappings.length);
    for (const m of mappings.slice(0, 5)) {
      console.log(
        "    port:", m.public.port,
        "host:", m.private.host,
        "desc:", m.description,
        "ttl:", m.ttl,
        "local:", m.local
      );
    }
    if (mappings.length > 5) console.log("    ... and", mappings.length - 5, "more");
    return Array.isArray(mappings);
  });

  opts.run("Get local-only mappings", async () => {
    const all = await client.getMappings();
    const local = await client.getMappings({ local: true });
    console.log("  All:", all.length, "Local:", local.length);
    return local.every((m) => m.local === true) && local.length <= all.length;
  });

  // ==========================================
  // Port mapping CRUD
  // ==========================================

  opts.run("Create port mappings", async () => {
    for (let i = 0; i < 5; i++) {
      console.log("  Map %d -> %d", globalPort[i], localPort[i]);
      await client.createMapping({
        public: globalPort[i],
        private: localPort[i],
        ttl: 0,
      });
    }
    return true;
  });

  opts.run("Find mapped ports in listing", async () => {
    const mappings = await client.getMappings();
    let passed = true;
    for (let i = 0; i < 5; i++) {
      const found = mappings.some((m) => m.public.port === globalPort[i]);
      console.log("  Port", globalPort[i], found ? "found" : "NOT FOUND");
      if (!found) passed = false;
    }
    return passed;
  });

  opts.run("GetSpecificPortMappingEntry — find existing", async () => {
    const mapping = await client.getMapping({
      public: globalPort[0],
      protocol: "TCP",
    });
    console.log("  Port:", mapping?.public.port, "Host:", mapping?.private.host, "TTL:", mapping?.ttl);
    return mapping !== null && mapping.public.port === globalPort[0];
  });

  opts.run("GetSpecificPortMappingEntry — non-existent returns null", async () => {
    const mapping = await client.getMapping({ public: 1, protocol: "TCP" });
    console.log("  Result:", mapping);
    return mapping === null;
  });

  opts.run("Create mapping with TTL and verify read-back", async () => {
    const testPort = globalPort[0] + 100;
    await client.createMapping({
      public: testPort,
      private: testPort,
      description: "TTL_Test",
      ttl: 120,
    });
    const mapping = await client.getMapping({ public: testPort, protocol: "TCP" });
    console.log("  Requested TTL: 120, Read-back TTL:", mapping?.ttl);
    await client.removeMapping({ public: testPort });
    return mapping !== null && mapping.ttl > 0 && mapping.ttl <= 120;
  });

  opts.run("Create mapping without explicit private port", async () => {
    const testPort = globalPort[0] + 200;
    await client.createMapping({ public: testPort, description: "NoPrivatePort", ttl: 60 });
    const mapping = await client.getMapping({ public: testPort, protocol: "TCP" });
    console.log("  Public:", mapping?.public.port, "Private:", mapping?.private.port);
    await client.removeMapping({ public: testPort });
    return mapping !== null && mapping.private.port === testPort;
  });

  opts.run("Delete port mappings", async () => {
    for (let i = 0; i < 5; i++) {
      console.log("  Remove mapping for", globalPort[i]);
      await client.removeMapping({ public: globalPort[i] });
    }
    return true;
  });

  opts.run("Verify ports removed", async () => {
    const mappings = await client.getMappings();
    let passed = true;
    for (let i = 0; i < 5; i++) {
      const found = mappings.some((m) => m.public.port === globalPort[i]);
      console.log("  Port", globalPort[i], found ? "STILL EXISTS" : "removed");
      if (found) passed = false;
    }
    return passed;
  });

  // ==========================================
  // v2 actions (capability-gated)
  // ==========================================

  opts.run("v2 actions — gated by capabilities", async () => {
    const info = await client.getGateway();
    const capabilities = await info.getCapabilities();

    if (!capabilities || !capabilities.supportsAddAnyPortMapping) {
      try {
        await client.createAnyMapping({ public: 59990, description: "test", ttl: 60 });
        console.log("  createAnyMapping should have thrown but didn't");
        return false;
      } catch (err) {
        if (err instanceof UpnpError) {
          console.log("  createAnyMapping correctly rejected:", err.code, err.description);
        } else {
          console.log("  createAnyMapping threw unexpected error:", err);
          return false;
        }
      }
    } else {
      const result = await client.createAnyMapping({
        public: 59990,
        private: 59990,
        description: "V2Test",
        ttl: 60,
      });
      console.log("  createAnyMapping reserved port:", result.reservedPort);
      await client.removeMapping({ public: result.reservedPort });
    }

    if (!capabilities || !capabilities.supportsGetListOfPortMappings) {
      try {
        await client.getMappingRange({ startPort: 1, endPort: 65535, protocol: "TCP" });
        console.log("  getMappingRange should have thrown but didn't");
        return false;
      } catch (err) {
        if (err instanceof UpnpError) {
          console.log("  getMappingRange correctly rejected:", err.code);
        } else {
          console.log("  getMappingRange threw unexpected error:", err);
          return false;
        }
      }
    } else {
      const range = await client.getMappingRange({
        startPort: 1,
        endPort: 65535,
        protocol: "TCP",
      });
      console.log("  getMappingRange returned", range.length, "entries");
    }

    if (!capabilities || !capabilities.supportsDeletePortMappingRange) {
      try {
        await client.removeMappingRange({ startPort: 59990, endPort: 59990, protocol: "TCP" });
        console.log("  removeMappingRange should have thrown but didn't");
        return false;
      } catch (err) {
        if (err instanceof UpnpError) {
          console.log("  removeMappingRange correctly rejected:", err.code);
        }
      }
    }

    return true;
  });

  // The testcase above only proves the "not supported" branch on a v1 router.
  // These three run the v2 write path for real, and stand down on a v1 router
  // rather than duplicating the rejection assertions. test/igd2 stands up a
  // gateway that reaches them.

  opts.run("v2 getMappingRange — parse a real NewPortListing", async () => {
    const info = await client.getGateway();
    const capabilities = await info.getCapabilities();
    if (!capabilities?.supportsGetListOfPortMappings) {
      console.log("  GetListOfPortMappings not advertised — rejection covered above");
      return true;
    }

    const base = 41000;
    const ports = [base, base + 1, base + 2];
    const localAddress = await info.getLocalAddress();

    for (let i = 0; i < ports.length; i++) {
      await client.createMapping({
        public: ports[i],
        private: 8000 + i,
        description: "Range" + i,
        ttl: 300,
      });
    }

    try {
      const range = await client.getMappingRange({
        startPort: base,
        endPort: base + 10,
        protocol: "TCP",
      });
      console.log("  Entries returned:", range.length);
      for (const m of range) {
        console.log(
          "    ", m.public.port, "->", m.private.host + ":" + m.private.port,
          "desc:", m.description, "ttl:", m.ttl, "local:", m.local
        );
      }

      return ports.every((port, i) => {
        const entry = range.find((m) => m.public.port === port);
        if (!entry) {
          console.log("  Port", port, "missing from the listing");
          return false;
        }
        return (
          entry.private.port === 8000 + i &&
          entry.private.host === localAddress &&
          entry.description === "Range" + i &&
          entry.protocol === "tcp" &&
          entry.enabled &&
          entry.local &&
          entry.ttl > 0
        );
      });
    } finally {
      for (const port of ports) {
        await client.removeMapping({ public: port });
      }
    }
  });

  opts.run("v2 removeMappingRange — delete a real range", async () => {
    const info = await client.getGateway();
    const capabilities = await info.getCapabilities();
    if (!capabilities?.supportsDeletePortMappingRange) {
      console.log("  DeletePortMappingRange not advertised — rejection covered above");
      return true;
    }

    const base = 41100;
    const ports = [base, base + 1, base + 2];
    for (let i = 0; i < ports.length; i++) {
      await client.createMapping({
        public: ports[i],
        private: 8100 + i,
        description: "DelRange" + i,
        ttl: 300,
      });
    }

    const before = await client.getMappings();
    const createdCount = ports.filter((port) => before.some((m) => m.public.port === port)).length;
    console.log("  Created", createdCount, "of", ports.length, "before the range delete");

    await client.removeMappingRange({ startPort: base, endPort: base + 10, protocol: "TCP" });

    const after = await client.getMappings();
    const survivors = ports.filter((port) => after.some((m) => m.public.port === port));
    console.log("  Survivors after the range delete:", survivors.length ? survivors.join(", ") : "none");

    return createdCount === ports.length && survivors.length === 0;
  });

  opts.run("v2 createAnyMapping — the reserved port is really mapped", async () => {
    const info = await client.getGateway();
    const capabilities = await info.getCapabilities();
    if (!capabilities?.supportsAddAnyPortMapping) {
      console.log("  AddAnyPortMapping not advertised — rejection covered above");
      return true;
    }

    // A router may hand back the port asked for or pick another; the contract
    // is only that whatever it reserves is the port that ends up mapped.
    const requested = 41200;
    const result = await client.createAnyMapping({
      public: requested,
      private: 8200,
      description: "AnyPort",
      ttl: 300,
    });
    console.log("  Requested:", requested, "Reserved:", result.reservedPort);

    try {
      const mapping = await client.getMapping({
        public: result.reservedPort,
        protocol: "TCP",
      });
      console.log("  Read back:", mapping?.public.port, "->", mapping?.private.port, mapping?.description);
      return (
        result.reservedPort > 0 &&
        mapping !== null &&
        mapping.private.port === 8200 &&
        mapping.description === "AnyPort"
      );
    } finally {
      await client.removeMapping({ public: result.reservedPort });
    }
  });

  // ==========================================
  // SSDP bypass and caching
  // ==========================================

  opts.run("Cache gateway and run without SSDP", async () => {
    const upnpInfo = await client.getGateway();
    console.log("  Gateway URL:", upnpInfo.gateway.description);
    console.log("  Local address:", await upnpInfo.getLocalAddress());

    const nonSsdpClient = new Client({
      url: upnpInfo.gateway.description,
      localAddress: await upnpInfo.getLocalAddress(),
    });
    const nonSsdpInfo = await nonSsdpClient.getGateway();
    const nonSsdpDevice = await nonSsdpInfo.getDevice();
    const device = await upnpInfo.getDevice();
    console.log("  Non-SSDP address:", await nonSsdpInfo.getLocalAddress());
    if (nonSsdpDevice) {
      console.log("  Non-SSDP device:", nonSsdpDevice.manufacturer, nonSsdpDevice.modelName);
    }

    const same =
      await nonSsdpInfo.getLocalAddress() === await upnpInfo.getLocalAddress() &&
      (!nonSsdpDevice || !device || nonSsdpDevice.manufacturer === device.manufacturer);
    nonSsdpClient.close();
    return same;
  });

  if (iptablesPresent()) {
    opts.run("Verify caching survives SSDP block", async () => {
      const clientCaching = new Client({ cacheGateway: true });
      const clientDefault = new Client();

      await clientCaching.getGateway();
      const defaultMappings = await clientDefault.getMappings();
      console.log("  Default mappings:", defaultMappings.length);

      console.log("  Blocking SSDP via iptables...");
      execSync("iptables -A OUTPUT -p udp --dport 1900 -j DROP");

      try {
        const cachedMappings = await clientCaching.getMappings();
        console.log("  Cached client mappings:", cachedMappings.length);

        let defaultFailed = false;
        try {
          await clientDefault.getMappings();
        } catch {
          defaultFailed = true;
          console.log("  Default client correctly failed");
        }

        // Compare identity, not the countdown. ttl is the router's *remaining*
        // lease, so it decrements once a second on a live table; comparing the
        // raw objects made this a race against the wall clock, failing whenever
        // a second boundary fell between the two reads.
        const identity = (mappings: Mapping[]) =>
          JSON.stringify(
            mappings.map((m) => [
              m.protocol,
              m.public.host,
              m.public.port,
              m.private.host,
              m.private.port,
              m.enabled,
              m.description,
            ])
          );

        return identity(defaultMappings) === identity(cachedMappings) && defaultFailed;
      } finally {
        console.log("  Unblocking SSDP via iptables...");
        execSync("iptables -D OUTPUT -p udp --dport 1900 -j DROP");
        clientCaching.close();
        clientDefault.close();
      }
    });
  }
});
