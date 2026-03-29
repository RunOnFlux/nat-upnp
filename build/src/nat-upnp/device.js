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
exports.UpnpError = exports.Device = exports.xmlParser = void 0;
const axios_1 = __importDefault(require("axios"));
const dgram_1 = __importDefault(require("dgram"));
const http_1 = __importDefault(require("http"));
const url_1 = require("url");
const fast_xml_parser_1 = require("fast-xml-parser");
// Shared XML parser with XXE protection.
exports.xmlParser = new fast_xml_parser_1.XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    processEntities: false,
});
// UPnP devices (especially miniupnpd) always respond with Connection: close.
// Node.js 19+ defaults to keepAlive: true on the global agent, which causes
// "socket hang up" errors when trying to reuse connections the server already closed.
const upnpAgent = new http_1.default.Agent({ keepAlive: false });
// Prevent OOM from malicious/broken router responses
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const axiosDefaults = {
    httpAgent: upnpAgent,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
};
class Device {
    constructor(url) {
        // Lazy-init promises — concurrent callers share the same promise
        this.descriptionPromise = null;
        this.servicePromise = null;
        this.deviceInfoPromise = null;
        this.capabilitiesPromise = null;
        this.localAddressPromise = null;
        this.description = url;
        this.services = [
            "urn:schemas-upnp-org:service:WANIPConnection:2",
            "urn:schemas-upnp-org:service:WANIPConnection:1",
            "urn:schemas-upnp-org:service:WANPPPConnection:1",
        ];
    }
    /**
     * Fetch and parse the root device description XML.
     * Concurrent calls share one promise.
     */
    fetchDescription() {
        if (!this.descriptionPromise) {
            this.descriptionPromise = axios_1.default
                .get(this.description, axiosDefaults)
                .then(({ data }) => exports.xmlParser.parse(data));
        }
        return this.descriptionPromise;
    }
    /**
     * Determine the local interface address used to reach this device.
     * Uses UDP connect (zero-packet kernel route query) — the standard technique
     * used by miniupnpc, Python, Go, Docker, and Kubernetes.
     * Cached after first call.
     */
    getLocalAddress() {
        if (!this.localAddressPromise) {
            const routerIp = new url_1.URL(this.description).hostname;
            this.localAddressPromise = resolveLocalAddress(routerIp);
        }
        return this.localAddressPromise;
    }
    /**
     * Parse device info from rootDesc.xml. Returns null on failure.
     */
    getDeviceInfo() {
        if (!this.deviceInfoPromise) {
            this.deviceInfoPromise = this.buildDeviceInfo().catch(() => null);
        }
        return this.deviceInfoPromise;
    }
    buildDeviceInfo() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
        return __awaiter(this, void 0, void 0, function* () {
            const parsed = yield this.fetchDescription();
            const root = (parsed === null || parsed === void 0 ? void 0 : parsed.root) || {};
            const device = root.device || {};
            const { devices } = this.parseDescription({ device });
            const info = {
                friendlyName: String((_a = device.friendlyName) !== null && _a !== void 0 ? _a : ""),
                manufacturer: String((_b = device.manufacturer) !== null && _b !== void 0 ? _b : ""),
                manufacturerURL: String((_c = device.manufacturerURL) !== null && _c !== void 0 ? _c : ""),
                modelDescription: String((_d = device.modelDescription) !== null && _d !== void 0 ? _d : ""),
                modelName: String((_e = device.modelName) !== null && _e !== void 0 ? _e : ""),
                modelNumber: String((_f = device.modelNumber) !== null && _f !== void 0 ? _f : ""),
                modelURL: String((_g = device.modelURL) !== null && _g !== void 0 ? _g : ""),
                serialNumber: String((_h = device.serialNumber) !== null && _h !== void 0 ? _h : ""),
                UDN: String((_j = device.UDN) !== null && _j !== void 0 ? _j : ""),
                presentationURL: String((_k = device.presentationURL) !== null && _k !== void 0 ? _k : ""),
                specVersion: {
                    major: Number((_l = root.specVersion) === null || _l === void 0 ? void 0 : _l.major) || 0,
                    minor: Number((_m = root.specVersion) === null || _m === void 0 ? void 0 : _m.minor) || 0,
                },
                configId: root["@_configId"] ? String(root["@_configId"]) : null,
                descriptionURL: this.description,
            };
            const wanDevice = devices.find((d) => {
                var _a, _b;
                return ((_a = d.deviceType) === null || _a === void 0 ? void 0 : _a.includes("WANDevice")) ||
                    ((_b = d.deviceType) === null || _b === void 0 ? void 0 : _b.includes("WANConnectionDevice"));
            });
            if (wanDevice && wanDevice !== device) {
                info.wan = {
                    manufacturer: String((_o = wanDevice.manufacturer) !== null && _o !== void 0 ? _o : ""),
                    modelDescription: String((_p = wanDevice.modelDescription) !== null && _p !== void 0 ? _p : ""),
                    modelName: String((_q = wanDevice.modelName) !== null && _q !== void 0 ? _q : ""),
                    modelNumber: String((_r = wanDevice.modelNumber) !== null && _r !== void 0 ? _r : ""),
                };
            }
            return info;
        });
    }
    /**
     * Fetch and parse the SCPD to discover supported actions. Returns null on failure.
     */
    getCapabilities() {
        if (!this.capabilitiesPromise) {
            this.capabilitiesPromise = this.buildCapabilities().catch(() => null);
        }
        return this.capabilitiesPromise;
    }
    buildCapabilities() {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const service = yield this.resolveService();
            let parsed;
            try {
                const { data } = yield axios_1.default.get(service.SCPDURL, axiosDefaults);
                parsed = exports.xmlParser.parse(data);
            }
            catch (_c) {
                return null;
            }
            const actionList = (_b = (_a = parsed === null || parsed === void 0 ? void 0 : parsed.scpd) === null || _a === void 0 ? void 0 : _a.actionList) === null || _b === void 0 ? void 0 : _b.action;
            const actions = [];
            if (Array.isArray(actionList)) {
                for (const a of actionList) {
                    if (a === null || a === void 0 ? void 0 : a.name)
                        actions.push(String(a.name));
                }
            }
            else if (actionList === null || actionList === void 0 ? void 0 : actionList.name) {
                actions.push(String(actionList.name));
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
        });
    }
    /**
     * Resolve the service control URL. Prefers v2 > v1 > PPP.
     */
    resolveService() {
        if (!this.servicePromise) {
            this.servicePromise = this.buildResolvedService();
        }
        return this.servicePromise;
    }
    buildResolvedService() {
        return __awaiter(this, void 0, void 0, function* () {
            const parsed = yield this.fetchDescription();
            const root = parsed === null || parsed === void 0 ? void 0 : parsed.root;
            if (!root)
                throw new Error("Invalid device description: no root element");
            const allServices = this.parseDescription(root).services;
            let matched;
            for (const preferred of this.services) {
                matched = allServices.find((s) => s.serviceType === preferred);
                if (matched)
                    break;
            }
            if (!(matched === null || matched === void 0 ? void 0 : matched.controlURL) || !(matched === null || matched === void 0 ? void 0 : matched.SCPDURL)) {
                const available = allServices.map((s) => s.serviceType).join(", ");
                throw new Error(`UPnP service not found. Available: ${available || "none"}`);
            }
            const baseUrl = new url_1.URL(root.baseURL || "", this.description);
            const prefix = (url) => new url_1.URL(url, baseUrl.toString()).toString();
            return {
                service: matched.serviceType,
                SCPDURL: prefix(matched.SCPDURL),
                controlURL: prefix(matched.controlURL),
            };
        });
    }
    getService(types) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.resolveService();
        });
    }
    run(action, args) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            const info = yield this.resolveService();
            const argsXml = args
                .map(([name, value]) => `<${name}>${escapeXml(String(value !== null && value !== void 0 ? value : ""))}</${name}>`)
                .join("");
            const body = '<?xml version="1.0"?>' +
                '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
                's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
                "<s:Body>" +
                `<u:${action} xmlns:u=${JSON.stringify(info.service)}>` +
                argsXml +
                `</u:${action}>` +
                "</s:Body>" +
                "</s:Envelope>";
            let responseData;
            try {
                const response = yield axios_1.default.post(info.controlURL, body, Object.assign(Object.assign({}, axiosDefaults), { headers: {
                        "Content-Type": 'text/xml; charset="utf-8"',
                        "Content-Length": "" + Buffer.byteLength(body),
                        SOAPAction: JSON.stringify(info.service + "#" + action),
                    } }));
                responseData = response.data;
            }
            catch (err) {
                if ((_a = err === null || err === void 0 ? void 0 : err.response) === null || _a === void 0 ? void 0 : _a.data) {
                    throwIfSoapFault(err.response.data, action);
                }
                throw err;
            }
            let parsed;
            try {
                parsed = exports.xmlParser.parse(responseData);
            }
            catch (_c) {
                throw new Error(`Malformed XML response for ${action}`);
            }
            const soapBody = (_b = parsed === null || parsed === void 0 ? void 0 : parsed.Envelope) === null || _b === void 0 ? void 0 : _b.Body;
            if (!soapBody) {
                throw new Error(`Malformed SOAP envelope for ${action}`);
            }
            if (soapBody.Fault) {
                throwSoapFault(soapBody.Fault, action);
            }
            return soapBody;
        });
    }
    parseDescription(info) {
        const services = [];
        const devices = [];
        function traverseDevices(device) {
            var _a, _b;
            if (!device || typeof device !== "object")
                return;
            devices.push(device);
            const serviceList = (_a = device.serviceList) === null || _a === void 0 ? void 0 : _a.service;
            if (serviceList) {
                const items = Array.isArray(serviceList) ? serviceList : [serviceList];
                for (const svc of items) {
                    if (svc && typeof svc === "object" && svc.serviceType) {
                        services.push(svc);
                    }
                }
            }
            const deviceList = (_b = device.deviceList) === null || _b === void 0 ? void 0 : _b.device;
            if (deviceList) {
                const items = Array.isArray(deviceList) ? deviceList : [deviceList];
                items.forEach(traverseDevices);
            }
        }
        traverseDevices(info.device);
        return { services, devices };
    }
}
exports.Device = Device;
exports.default = Device;
/*
 * =======================
 * ====== Utilities ======
 * =======================
 */
/**
 * Determine which local interface address the OS would use to reach a remote IP.
 * Uses UDP connect — a zero-packet kernel route query. The standard technique used
 * by miniupnpc, Python, Go, Docker, and Kubernetes.
 * No data is sent on the wire.
 */
function resolveLocalAddress(remoteIp) {
    return new Promise((resolve, reject) => {
        const socket = dgram_1.default.createSocket("udp4");
        socket.connect(80, remoteIp, () => {
            const address = socket.address().address;
            socket.close();
            resolve(address);
        });
        socket.on("error", (err) => {
            try {
                socket.close();
            }
            catch ( /* already closed */_a) { /* already closed */ }
            reject(err);
        });
    });
}
const XML_ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
};
function escapeXml(str) {
    return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch]);
}
function extractFaultInfo(fault) {
    var _a, _b, _c, _d;
    const rawCode = (_b = (_a = fault === null || fault === void 0 ? void 0 : fault.detail) === null || _a === void 0 ? void 0 : _a.UPnPError) === null || _b === void 0 ? void 0 : _b.errorCode;
    const rawDesc = (_d = (_c = fault === null || fault === void 0 ? void 0 : fault.detail) === null || _c === void 0 ? void 0 : _c.UPnPError) === null || _d === void 0 ? void 0 : _d.errorDescription;
    return {
        code: rawCode ? Number(rawCode) || 0 : 0,
        description: rawDesc ? String(rawDesc) : String((fault === null || fault === void 0 ? void 0 : fault.faultstring) || "Unknown UPnP error"),
    };
}
function throwSoapFault(fault, action) {
    const { code, description } = extractFaultInfo(fault);
    throw new UpnpError(code, description, action);
}
function throwIfSoapFault(data, action) {
    var _a, _b;
    try {
        const parsed = exports.xmlParser.parse(data);
        const fault = (_b = (_a = parsed === null || parsed === void 0 ? void 0 : parsed.Envelope) === null || _a === void 0 ? void 0 : _a.Body) === null || _b === void 0 ? void 0 : _b.Fault;
        if (fault)
            throwSoapFault(fault, action);
    }
    catch (err) {
        if (err instanceof UpnpError)
            throw err;
    }
}
/*
 * ==================
 * ====== Errors ====
 * ==================
 */
class UpnpError extends Error {
    constructor(code, description, action) {
        super(`UPnP error ${code}: ${description} (action: ${action})`);
        this.name = "UpnpError";
        this.code = Number(code) || 0;
        this.description = String(description || "Unknown");
        this.action = String(action || "Unknown");
    }
}
exports.UpnpError = UpnpError;
