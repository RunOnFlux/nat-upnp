"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = __importDefault(require("net"));
const index_flux_test_1 = require("./index.flux-test");
const src_1 = require("../src");
const node_child_process_1 = require("node:child_process");
(0, index_flux_test_1.setupTest)("NAT-UPNP/Client", (opts) => {
    let client;
    const globalPort = [];
    const localPort = [];
    for (let i = 0; i < 5; i++) {
        globalPort[i] = ~~(Math.random() * 10000 + 30000);
        localPort[i] = ~~(Math.random() * 1000 + 7000);
    }
    function iptablesPresent() {
        try {
            (0, node_child_process_1.execSync)("iptables --version", { stdio: "pipe" });
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    opts.runBefore(() => {
        client = new src_1.Client();
    });
    opts.runAfter(() => {
        client.close();
    });
    // ==========================================
    // Gateway discovery, device info, capabilities
    // ==========================================
    opts.run("Discover gateway and get device info", () => __awaiter(void 0, void 0, void 0, function* () {
        const info = yield client.getGateway();
        const device = yield info.getDevice();
        console.log("  Local address:", yield info.getLocalAddress());
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
        return (net_1.default.isIP(yield info.getLocalAddress()) !== 0 &&
            !!device &&
            device.manufacturer.length > 0 &&
            info.gateway.description.startsWith("http"));
    }));
    opts.run("Parse service capabilities from SCPD", () => __awaiter(void 0, void 0, void 0, function* () {
        const info = yield client.getGateway();
        const capabilities = yield info.getCapabilities();
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
        return (capabilities.serviceType.includes("WANIPConnection") &&
            capabilities.serviceVersion >= 1 &&
            capabilities.actions.length > 0 &&
            capabilities.actions.includes("AddPortMapping") &&
            capabilities.actions.includes("DeletePortMapping") &&
            Array.isArray(capabilities.actions));
    }));
    opts.run("Gateway caching — second call is instant", () => __awaiter(void 0, void 0, void 0, function* () {
        yield client.getGateway();
        const start = Date.now();
        yield client.getGateway();
        const elapsed = Date.now() - start;
        console.log("  Second call took:", elapsed, "ms");
        return elapsed < 50;
    }));
    opts.run("Device info caching — second call is instant", () => __awaiter(void 0, void 0, void 0, function* () {
        const info = yield client.getGateway();
        yield info.getDevice(); // first call fetches
        const start = Date.now();
        yield info.getDevice(); // second call cached
        const elapsed = Date.now() - start;
        console.log("  Second call took:", elapsed, "ms");
        return elapsed < 5;
    }));
    // ==========================================
    // Basic v1 operations
    // ==========================================
    opts.run("Get public IP address", () => __awaiter(void 0, void 0, void 0, function* () {
        const ip = yield client.getPublicIp();
        console.log("  Public IP:", ip);
        return net_1.default.isIP(ip) !== 0;
    }));
    opts.run("Get status info (uptime)", () => __awaiter(void 0, void 0, void 0, function* () {
        const status = yield client.getStatusInfo();
        console.log("  Status:", status.connectionStatus);
        console.log("  Uptime:", status.uptime, "seconds");
        console.log("  Last error:", status.lastConnectionError);
        return (typeof status.uptime === "number" &&
            status.uptime > 0 &&
            typeof status.connectionStatus === "string");
    }));
    opts.run("Display existing port mappings", () => __awaiter(void 0, void 0, void 0, function* () {
        const mappings = yield client.getMappings();
        console.log("  Total mappings:", mappings.length);
        for (const m of mappings.slice(0, 5)) {
            console.log("    port:", m.public.port, "host:", m.private.host, "desc:", m.description, "ttl:", m.ttl, "local:", m.local);
        }
        if (mappings.length > 5)
            console.log("    ... and", mappings.length - 5, "more");
        return Array.isArray(mappings);
    }));
    opts.run("Get local-only mappings", () => __awaiter(void 0, void 0, void 0, function* () {
        const all = yield client.getMappings();
        const local = yield client.getMappings({ local: true });
        console.log("  All:", all.length, "Local:", local.length);
        return local.every((m) => m.local === true) && local.length <= all.length;
    }));
    // ==========================================
    // Port mapping CRUD
    // ==========================================
    opts.run("Create port mappings", () => __awaiter(void 0, void 0, void 0, function* () {
        for (let i = 0; i < 5; i++) {
            console.log("  Map %d -> %d", globalPort[i], localPort[i]);
            yield client.createMapping({
                public: globalPort[i],
                private: localPort[i],
                ttl: 0,
            });
        }
        return true;
    }));
    opts.run("Find mapped ports in listing", () => __awaiter(void 0, void 0, void 0, function* () {
        const mappings = yield client.getMappings();
        let passed = true;
        for (let i = 0; i < 5; i++) {
            const found = mappings.some((m) => m.public.port === globalPort[i]);
            console.log("  Port", globalPort[i], found ? "found" : "NOT FOUND");
            if (!found)
                passed = false;
        }
        return passed;
    }));
    opts.run("GetSpecificPortMappingEntry — find existing", () => __awaiter(void 0, void 0, void 0, function* () {
        const mapping = yield client.getMapping({
            public: globalPort[0],
            protocol: "TCP",
        });
        console.log("  Port:", mapping === null || mapping === void 0 ? void 0 : mapping.public.port, "Host:", mapping === null || mapping === void 0 ? void 0 : mapping.private.host, "TTL:", mapping === null || mapping === void 0 ? void 0 : mapping.ttl);
        return mapping !== null && mapping.public.port === globalPort[0];
    }));
    opts.run("GetSpecificPortMappingEntry — non-existent returns null", () => __awaiter(void 0, void 0, void 0, function* () {
        const mapping = yield client.getMapping({ public: 1, protocol: "TCP" });
        console.log("  Result:", mapping);
        return mapping === null;
    }));
    opts.run("Create mapping with TTL and verify read-back", () => __awaiter(void 0, void 0, void 0, function* () {
        const testPort = globalPort[0] + 100;
        yield client.createMapping({
            public: testPort,
            private: testPort,
            description: "TTL_Test",
            ttl: 120,
        });
        const mapping = yield client.getMapping({ public: testPort, protocol: "TCP" });
        console.log("  Requested TTL: 120, Read-back TTL:", mapping === null || mapping === void 0 ? void 0 : mapping.ttl);
        yield client.removeMapping({ public: testPort });
        return mapping !== null && mapping.ttl > 0 && mapping.ttl <= 120;
    }));
    opts.run("Create mapping without explicit private port", () => __awaiter(void 0, void 0, void 0, function* () {
        const testPort = globalPort[0] + 200;
        yield client.createMapping({ public: testPort, description: "NoPrivatePort", ttl: 60 });
        const mapping = yield client.getMapping({ public: testPort, protocol: "TCP" });
        console.log("  Public:", mapping === null || mapping === void 0 ? void 0 : mapping.public.port, "Private:", mapping === null || mapping === void 0 ? void 0 : mapping.private.port);
        yield client.removeMapping({ public: testPort });
        return mapping !== null && mapping.private.port === testPort;
    }));
    opts.run("Delete port mappings", () => __awaiter(void 0, void 0, void 0, function* () {
        for (let i = 0; i < 5; i++) {
            console.log("  Remove mapping for", globalPort[i]);
            yield client.removeMapping({ public: globalPort[i] });
        }
        return true;
    }));
    opts.run("Verify ports removed", () => __awaiter(void 0, void 0, void 0, function* () {
        const mappings = yield client.getMappings();
        let passed = true;
        for (let i = 0; i < 5; i++) {
            const found = mappings.some((m) => m.public.port === globalPort[i]);
            console.log("  Port", globalPort[i], found ? "STILL EXISTS" : "removed");
            if (found)
                passed = false;
        }
        return passed;
    }));
    // ==========================================
    // v2 actions (capability-gated)
    // ==========================================
    opts.run("v2 actions — gated by capabilities", () => __awaiter(void 0, void 0, void 0, function* () {
        const info = yield client.getGateway();
        const capabilities = yield info.getCapabilities();
        if (!capabilities || !capabilities.supportsAddAnyPortMapping) {
            try {
                yield client.createAnyMapping({ public: 59990, description: "test", ttl: 60 });
                console.log("  createAnyMapping should have thrown but didn't");
                return false;
            }
            catch (err) {
                if (err instanceof src_1.UpnpError) {
                    console.log("  createAnyMapping correctly rejected:", err.code, err.description);
                }
                else {
                    console.log("  createAnyMapping threw unexpected error:", err);
                    return false;
                }
            }
        }
        else {
            const result = yield client.createAnyMapping({
                public: 59990,
                private: 59990,
                description: "V2Test",
                ttl: 60,
            });
            console.log("  createAnyMapping reserved port:", result.reservedPort);
            yield client.removeMapping({ public: result.reservedPort });
        }
        if (!capabilities || !capabilities.supportsGetListOfPortMappings) {
            try {
                yield client.getMappingRange({ startPort: 1, endPort: 65535, protocol: "TCP" });
                console.log("  getMappingRange should have thrown but didn't");
                return false;
            }
            catch (err) {
                if (err instanceof src_1.UpnpError) {
                    console.log("  getMappingRange correctly rejected:", err.code);
                }
                else {
                    console.log("  getMappingRange threw unexpected error:", err);
                    return false;
                }
            }
        }
        else {
            const range = yield client.getMappingRange({
                startPort: 1,
                endPort: 65535,
                protocol: "TCP",
            });
            console.log("  getMappingRange returned", range.length, "entries");
        }
        if (!capabilities || !capabilities.supportsDeletePortMappingRange) {
            try {
                yield client.removeMappingRange({ startPort: 59990, endPort: 59990, protocol: "TCP" });
                console.log("  removeMappingRange should have thrown but didn't");
                return false;
            }
            catch (err) {
                if (err instanceof src_1.UpnpError) {
                    console.log("  removeMappingRange correctly rejected:", err.code);
                }
            }
        }
        return true;
    }));
    // ==========================================
    // SSDP bypass and caching
    // ==========================================
    opts.run("Cache gateway and run without SSDP", () => __awaiter(void 0, void 0, void 0, function* () {
        const upnpInfo = yield client.getGateway();
        console.log("  Gateway URL:", upnpInfo.gateway.description);
        console.log("  Local address:", yield upnpInfo.getLocalAddress());
        const nonSsdpClient = new src_1.Client({
            url: upnpInfo.gateway.description,
            localAddress: yield upnpInfo.getLocalAddress(),
        });
        const nonSsdpInfo = yield nonSsdpClient.getGateway();
        const nonSsdpDevice = yield nonSsdpInfo.getDevice();
        const device = yield upnpInfo.getDevice();
        console.log("  Non-SSDP address:", yield nonSsdpInfo.getLocalAddress());
        if (nonSsdpDevice) {
            console.log("  Non-SSDP device:", nonSsdpDevice.manufacturer, nonSsdpDevice.modelName);
        }
        const same = (yield nonSsdpInfo.getLocalAddress()) === (yield upnpInfo.getLocalAddress()) &&
            (!nonSsdpDevice || !device || nonSsdpDevice.manufacturer === device.manufacturer);
        nonSsdpClient.close();
        return same;
    }));
    if (iptablesPresent()) {
        opts.run("Verify caching survives SSDP block", () => __awaiter(void 0, void 0, void 0, function* () {
            const clientCaching = new src_1.Client({ cacheGateway: true });
            const clientDefault = new src_1.Client();
            yield clientCaching.getGateway();
            const defaultMappings = yield clientDefault.getMappings();
            console.log("  Default mappings:", defaultMappings.length);
            console.log("  Blocking SSDP via iptables...");
            (0, node_child_process_1.execSync)("iptables -A OUTPUT -p udp --dport 1900 -j DROP");
            try {
                const cachedMappings = yield clientCaching.getMappings();
                console.log("  Cached client mappings:", cachedMappings.length);
                let defaultFailed = false;
                try {
                    yield clientDefault.getMappings();
                }
                catch (_a) {
                    defaultFailed = true;
                    console.log("  Default client correctly failed");
                }
                return (JSON.stringify(defaultMappings) === JSON.stringify(cachedMappings) &&
                    defaultFailed);
            }
            finally {
                console.log("  Unblocking SSDP via iptables...");
                (0, node_child_process_1.execSync)("iptables -D OUTPUT -p udp --dport 1900 -j DROP");
                clientCaching.close();
                clientDefault.close();
            }
        }));
    }
});
