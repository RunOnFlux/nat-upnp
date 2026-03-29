"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Ssdp = void 0;
const dgram_1 = __importDefault(require("dgram"));
const events_1 = __importDefault(require("events"));
/**
 * SSDP discovery. Finds UPnP devices on the local network via multicast.
 * Emits device Location URLs — does not resolve local addresses (that's the caller's job).
 */
class Ssdp {
    constructor(options) {
        this.multicast = "239.255.255.250";
        this.port = 1900;
        this.ssdpEmitter = new events_1.default();
        this.socket = null;
        this.bound = false;
        this.closed = false;
        this.pendingSearches = [];
        this.sourcePort = (options === null || options === void 0 ? void 0 : options.sourcePort) || 0;
    }
    ensureSocket() {
        if (this.socket)
            return this.socket;
        const socket = dgram_1.default.createSocket({ type: "udp4", reuseAddr: true });
        this.socket = socket;
        socket.on("message", (message) => {
            if (this.closed)
                return;
            this.parseResponse(message.toString("utf-8"));
        });
        socket.on("listening", () => {
            this.bound = true;
            while (this.pendingSearches.length > 0) {
                const [device, emitter] = this.pendingSearches.shift();
                this.search(device, emitter);
            }
        });
        socket.once("error", () => {
            this.bound = false;
            this.socket = null;
            try {
                socket.close();
            }
            catch ( /* already closed */_a) { /* already closed */ }
        });
        socket.bind(this.sourcePort);
        return socket;
    }
    parseResponse(response) {
        if (!/^(HTTP|NOTIFY)/m.test(response))
            return;
        const headers = parseMimeHeader(response);
        if (!headers.st)
            return;
        this.ssdpEmitter.emit("device", headers);
    }
    search(device, emitter) {
        if (!emitter) {
            emitter = new events_1.default();
        }
        this.ensureSocket();
        if (!this.bound) {
            this.pendingSearches.push([device, emitter]);
            return emitter;
        }
        const query = Buffer.from("M-SEARCH * HTTP/1.1\r\n" +
            "HOST: " + this.multicast + ":" + this.port + "\r\n" +
            'MAN: "ssdp:discover"\r\n' +
            "MX: 1\r\n" +
            "ST: " + device + "\r\n" +
            "\r\n");
        this.socket.send(query, 0, query.length, this.port, this.multicast);
        let ended = false;
        const ondevice = (headers) => {
            if (ended || headers.st !== device)
                return;
            emitter.emit("device", headers);
        };
        this.ssdpEmitter.on("device", ondevice);
        emitter.once("end", () => {
            ended = true;
            this.ssdpEmitter.removeListener("device", ondevice);
        });
        return emitter;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.bound = false;
        this.pendingSearches.length = 0;
        this.ssdpEmitter.removeAllListeners();
        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.close();
            }
            catch ( /* already closed */_a) { /* already closed */ }
            this.socket = null;
        }
    }
}
exports.Ssdp = Ssdp;
function parseMimeHeader(headerStr) {
    const lines = headerStr.split(/\r?\n/);
    return lines.reduce((headers, line) => {
        const match = line.match(/^([^:]+)\s*:\s*(.*)$/);
        if (match) {
            headers[match[1].toLowerCase()] = match[2].trimEnd();
        }
        return headers;
    }, {});
}
exports.default = Ssdp;
