"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
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
exports.Client = exports.UpnpInfo = void 0;
const device_1 = __importStar(require("./device"));
const ssdp_1 = __importDefault(require("./ssdp"));
/**
 * Holds the resolved gateway and provides lazy access to device info,
 * capabilities, and local address. All are fetched on first access and cached.
 */
class UpnpInfo {
    constructor(gateway, localAddressOverride) {
        this.devicePromise = null;
        this.capabilitiesPromise = null;
        this.gateway = gateway;
        this.localAddressOverride = localAddressOverride || null;
    }
    /** Fetch and cache device info from rootDesc.xml. Returns null on failure. */
    getDevice() {
        if (!this.devicePromise) {
            this.devicePromise = this.gateway.getDeviceInfo();
        }
        return this.devicePromise;
    }
    /** Fetch and cache service capabilities from SCPD. Returns null on failure. */
    getCapabilities() {
        if (!this.capabilitiesPromise) {
            this.capabilitiesPromise = this.gateway.getCapabilities();
        }
        return this.capabilitiesPromise;
    }
    /**
     * Get the local interface address used to reach the router.
     * If a localAddress was provided at construction (SSDP bypass mode), returns that.
     * Otherwise resolves via UDP connect (zero-packet kernel route query).
     */
    getLocalAddress() {
        if (this.localAddressOverride) {
            return Promise.resolve(this.localAddressOverride);
        }
        return this.gateway.getLocalAddress();
    }
}
exports.UpnpInfo = UpnpInfo;
class Client {
    constructor(options = {}) {
        this.ssdp = new ssdp_1.default();
        this.cachedInfo = null;
        if (options.url && !options.localAddress) {
            throw new Error("`localAddress` must be supplied if using `url`");
        }
        this.timeout = options.timeout || 1800;
        this.url = options.url || null;
        this.localAddress = options.localAddress || null;
        this.cacheGateway = options.cacheGateway || false;
    }
    createMapping(options) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const localAddress = yield info.getLocalAddress();
            const ports = normalizeOptions(options);
            return info.gateway.run("AddPortMapping", [
                ["NewRemoteHost", (_a = ports.remote.host) !== null && _a !== void 0 ? _a : ""],
                ["NewExternalPort", String(ports.remote.port)],
                ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
                ["NewInternalPort", String(ports.internal.port)],
                ["NewInternalClient", ports.internal.host || localAddress],
                ["NewEnabled", 1],
                ["NewPortMappingDescription", options.description || "node:nat:upnp"],
                ["NewLeaseDuration", (_b = options.ttl) !== null && _b !== void 0 ? _b : 60 * 30],
            ]);
        });
    }
    removeMapping(options) {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const ports = normalizeOptions(options);
            return info.gateway.run("DeletePortMapping", [
                ["NewRemoteHost", (_a = ports.remote.host) !== null && _a !== void 0 ? _a : ""],
                ["NewExternalPort", String(ports.remote.port)],
                ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
            ]);
        });
    }
    getMappings(options = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const localAddress = options.local ? yield info.getLocalAddress() : "";
            const results = [];
            const MAX_MAPPINGS = 10000;
            for (let i = 0; i < MAX_MAPPINGS; i++) {
                let data;
                try {
                    data = yield info.gateway.run("GetGenericPortMappingEntry", [
                        ["NewPortMappingIndex", i],
                    ]);
                }
                catch (_a) {
                    break;
                }
                const res = findResponseKey(data, "GetGenericPortMappingEntryResponse");
                if (!res)
                    break;
                const mapping = parseMapping(res, localAddress);
                if (options.local && !mapping.local)
                    continue;
                if (options.description && !matchesDescription(mapping.description, options.description))
                    continue;
                results.push(mapping);
            }
            return results;
        });
    }
    /**
     * Query a specific port mapping by external port and protocol.
     * O(1) lookup — single SOAP call, no iteration.
     * Returns null if the mapping does not exist.
     */
    getMapping(options) {
        var _a, _b, _c, _d;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const localAddress = yield info.getLocalAddress();
            const protocol = (options.protocol || "TCP").toUpperCase();
            let data;
            try {
                data = yield info.gateway.run("GetSpecificPortMappingEntry", [
                    ["NewRemoteHost", (_a = options.remoteHost) !== null && _a !== void 0 ? _a : ""],
                    ["NewExternalPort", String(options.public)],
                    ["NewProtocol", protocol],
                ]);
            }
            catch (err) {
                if (err instanceof device_1.UpnpError && (err.code === 714 || err.code === 713))
                    return null;
                throw err;
            }
            const res = findResponseKey(data, "GetSpecificPortMappingEntryResponse");
            if (!res)
                throw new Error("Incorrect response for GetSpecificPortMappingEntry");
            const host = String((_b = res.NewInternalClient) !== null && _b !== void 0 ? _b : "");
            return {
                public: { host: (_c = options.remoteHost) !== null && _c !== void 0 ? _c : "", port: Number(options.public) },
                private: { host, port: parseInt(res.NewInternalPort, 10) || 0 },
                protocol: protocol.toLowerCase(),
                enabled: res.NewEnabled === 1 || res.NewEnabled === "1",
                description: String((_d = res.NewPortMappingDescription) !== null && _d !== void 0 ? _d : ""),
                ttl: parseInt(res.NewLeaseDuration, 10) || 0,
                local: host === localAddress,
            };
        });
    }
    getStatusInfo() {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const data = yield info.gateway.run("GetStatusInfo", []);
            const res = findResponseKey(data, "GetStatusInfoResponse");
            if (!res)
                throw new Error("Incorrect response for GetStatusInfo");
            return {
                connectionStatus: String((_a = res.NewConnectionStatus) !== null && _a !== void 0 ? _a : ""),
                lastConnectionError: String((_b = res.NewLastConnectionError) !== null && _b !== void 0 ? _b : ""),
                uptime: parseInt(res.NewUptime, 10) || 0,
            };
        });
    }
    getPublicIp() {
        var _a;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            const data = yield info.gateway.run("GetExternalIPAddress", []);
            const res = findResponseKey(data, "GetExternalIPAddressResponse");
            if (!res)
                throw new Error("Incorrect response for GetExternalIPAddress");
            return String((_a = res.NewExternalIPAddress) !== null && _a !== void 0 ? _a : "");
        });
    }
    /**
     * Create a port mapping, allowing the router to assign a different external port
     * if the requested one is taken. IGD v2 action.
     */
    createAnyMapping(options) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            yield this.requireCapability(info, "supportsAddAnyPortMapping", "AddAnyPortMapping");
            const localAddress = yield info.getLocalAddress();
            const ports = normalizeOptions(options);
            const data = yield info.gateway.run("AddAnyPortMapping", [
                ["NewRemoteHost", (_a = ports.remote.host) !== null && _a !== void 0 ? _a : ""],
                ["NewExternalPort", String(ports.remote.port)],
                ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
                ["NewInternalPort", String(ports.internal.port)],
                ["NewInternalClient", ports.internal.host || localAddress],
                ["NewEnabled", 1],
                ["NewPortMappingDescription", options.description || "node:nat:upnp"],
                ["NewLeaseDuration", (_b = options.ttl) !== null && _b !== void 0 ? _b : 60 * 30],
            ]);
            const res = findResponseKey(data, "AddAnyPortMappingResponse");
            if (!res)
                throw new Error("Incorrect response for AddAnyPortMapping");
            return { reservedPort: parseInt(res.NewReservedPort, 10) || 0 };
        });
    }
    removeMappingRange(options) {
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            yield this.requireCapability(info, "supportsDeletePortMappingRange", "DeletePortMappingRange");
            return info.gateway.run("DeletePortMappingRange", [
                ["NewStartPort", String(options.startPort)],
                ["NewEndPort", String(options.endPort)],
                ["NewProtocol", (options.protocol || "TCP").toUpperCase()],
                ["NewManage", options.manage ? "1" : "0"],
            ]);
        });
    }
    getMappingRange(options) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.getGateway();
            yield this.requireCapability(info, "supportsGetListOfPortMappings", "GetListOfPortMappings");
            const localAddress = yield info.getLocalAddress();
            const protocol = (options.protocol || "TCP").toUpperCase();
            const data = yield info.gateway.run("GetListOfPortMappings", [
                ["NewStartPort", String(options.startPort)],
                ["NewEndPort", String(options.endPort)],
                ["NewProtocol", protocol],
                ["NewManage", options.manage ? "1" : "0"],
                ["NewNumberOfPorts", String((_a = options.numberOfPorts) !== null && _a !== void 0 ? _a : 1000)],
            ]);
            const res = findResponseKey(data, "GetListOfPortMappingsResponse");
            if (!res)
                throw new Error("Incorrect response for GetListOfPortMappings");
            const portListing = res.NewPortListing;
            if (!portListing)
                return [];
            const parsed = device_1.xmlParser.parse(String(portListing));
            const list = (_b = parsed === null || parsed === void 0 ? void 0 : parsed.PortMappingList) === null || _b === void 0 ? void 0 : _b.PortMappingEntry;
            if (!list)
                return [];
            const entries = Array.isArray(list) ? list : [list];
            return entries.map((entry) => {
                var _a, _b, _c;
                const host = String((_a = entry.NewInternalClient) !== null && _a !== void 0 ? _a : "");
                return {
                    public: {
                        host: String((_b = entry.NewRemoteHost) !== null && _b !== void 0 ? _b : ""),
                        port: parseInt(entry.NewExternalPort, 10) || 0,
                    },
                    private: { host, port: parseInt(entry.NewInternalPort, 10) || 0 },
                    protocol: protocol.toLowerCase(),
                    enabled: entry.NewEnabled === "1" || entry.NewEnabled === 1,
                    description: String((_c = entry.NewDescription) !== null && _c !== void 0 ? _c : ""),
                    ttl: parseInt(entry.NewLeaseTime, 10) || 0,
                    local: host === localAddress,
                };
            });
        });
    }
    getGateway() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.url) {
                if (!this.cachedInfo) {
                    this.cachedInfo = new UpnpInfo(new device_1.default(this.url), this.localAddress);
                }
                return this.cachedInfo;
            }
            if (this.cachedInfo)
                return this.cachedInfo;
            let resolved = false;
            const p = this.ssdp.search("urn:schemas-upnp-org:device:InternetGatewayDevice:1");
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    p.emit("end");
                    if (this.cachedInfo) {
                        resolve(this.cachedInfo);
                        return;
                    }
                    if (!resolved) {
                        resolved = true;
                        reject(new Error("Connection timed out while searching for the gateway."));
                    }
                }, this.timeout);
                p.on("device", (headers) => {
                    if (resolved)
                        return;
                    resolved = true;
                    p.emit("end");
                    clearTimeout(timeout);
                    const upnpInfo = new UpnpInfo(new device_1.default(headers.location));
                    if (this.cacheGateway) {
                        this.cachedInfo = upnpInfo;
                    }
                    resolve(upnpInfo);
                });
            });
        });
    }
    close() {
        this.ssdp.close();
    }
    requireCapability(info, capability, action) {
        return __awaiter(this, void 0, void 0, function* () {
            const capabilities = yield info.getCapabilities();
            if (!capabilities) {
                throw new device_1.UpnpError(401, `Cannot verify ${action} support (SCPD unavailable)`, action);
            }
            if (!capabilities[capability]) {
                throw new device_1.UpnpError(401, `${action} not supported by this device`, action);
            }
        });
    }
}
exports.Client = Client;
/*
 * =======================
 * ====== Utilities ======
 * =======================
 */
function normalizeOptions(options) {
    function toObject(addr) {
        if (typeof addr === "number")
            return { port: addr };
        if (typeof addr === "string") {
            const n = parseInt(addr, 10);
            return isFinite(n) ? { port: n } : {};
        }
        if (typeof addr === "object" && addr !== null)
            return addr;
        return {};
    }
    const remote = toObject(options.public);
    const internal = toObject(options.private);
    if (internal.port === undefined && remote.port !== undefined) {
        internal.port = remote.port;
    }
    return { remote, internal };
}
function parseMapping(res, localAddress) {
    var _a, _b;
    const host = String((_a = res.NewInternalClient) !== null && _a !== void 0 ? _a : "");
    return {
        public: {
            host: typeof res.NewRemoteHost === "string" ? res.NewRemoteHost : "",
            port: parseInt(res.NewExternalPort, 10) || 0,
        },
        private: { host, port: parseInt(res.NewInternalPort, 10) || 0 },
        protocol: res.NewProtocol ? String(res.NewProtocol).toLowerCase() : "tcp",
        enabled: res.NewEnabled === "1" || res.NewEnabled === 1,
        description: String((_b = res.NewPortMappingDescription) !== null && _b !== void 0 ? _b : ""),
        ttl: parseInt(res.NewLeaseDuration, 10) || 0,
        local: host === localAddress,
    };
}
function findResponseKey(data, prefix) {
    if (!data || typeof data !== "object")
        return null;
    const key = Object.keys(data).find((k) => k.startsWith(prefix));
    return key ? data[key] : null;
}
function matchesDescription(desc, filter) {
    if (typeof desc !== "string")
        return false;
    if (filter instanceof RegExp)
        return filter.test(desc);
    return desc.indexOf(filter) !== -1;
}
exports.default = Client;
