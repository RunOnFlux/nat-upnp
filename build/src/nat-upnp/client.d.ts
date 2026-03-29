import { RawResponse } from "../index";
import Device, { GatewayDevice, ServiceCapabilities } from "./device";
/**
 * Holds the resolved gateway and provides lazy access to device info,
 * capabilities, and local address. All are fetched on first access and cached.
 */
export declare class UpnpInfo {
    readonly gateway: Device;
    private readonly localAddressOverride;
    private devicePromise;
    private capabilitiesPromise;
    constructor(gateway: Device, localAddressOverride?: string);
    /** Fetch and cache device info from rootDesc.xml. Returns null on failure. */
    getDevice(): Promise<GatewayDevice | null>;
    /** Fetch and cache service capabilities from SCPD. Returns null on failure. */
    getCapabilities(): Promise<ServiceCapabilities | null>;
    /**
     * Get the local interface address used to reach the router.
     * If a localAddress was provided at construction (SSDP bypass mode), returns that.
     * Otherwise resolves via UDP connect (zero-packet kernel route query).
     */
    getLocalAddress(): Promise<string>;
}
export declare class Client implements IClient {
    private readonly timeout;
    private readonly ssdp;
    private readonly localAddress;
    private readonly cacheGateway;
    private cachedInfo;
    url: string | null;
    constructor(options?: ClientOptions);
    createMapping(options: NewPortMappingOpts): Promise<RawResponse>;
    removeMapping(options: DeletePortMappingOpts): Promise<RawResponse>;
    getMappings(options?: GetMappingOpts): Promise<Mapping[]>;
    /**
     * Query a specific port mapping by external port and protocol.
     * O(1) lookup — single SOAP call, no iteration.
     * Returns null if the mapping does not exist.
     */
    getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null>;
    getStatusInfo(): Promise<StatusInfo>;
    getPublicIp(): Promise<string>;
    /**
     * Create a port mapping, allowing the router to assign a different external port
     * if the requested one is taken. IGD v2 action.
     */
    createAnyMapping(options: NewPortMappingOpts): Promise<{
        reservedPort: number;
    }>;
    removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse>;
    getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]>;
    getGateway(): Promise<UpnpInfo>;
    close(): void;
    private requireCapability;
}
export default Client;
export interface Mapping {
    public: {
        host: string;
        port: number;
    };
    private: {
        host: string;
        port: number;
    };
    protocol: string;
    enabled: boolean;
    description: string;
    ttl: number;
    local: boolean;
}
export interface StatusInfo {
    connectionStatus: string;
    lastConnectionError: string;
    uptime: number;
}
export interface StandardOpts {
    public?: number | {
        port?: number;
        host?: string;
    };
    private?: number | {
        port?: number;
        host?: string;
    };
    protocol?: string;
}
export interface NewPortMappingOpts extends StandardOpts {
    description?: string;
    ttl?: number;
}
export type DeletePortMappingOpts = StandardOpts;
export interface GetMappingOpts {
    local?: boolean;
    description?: RegExp | string;
}
export interface GetSpecificMappingOpts {
    public: number;
    protocol?: string;
    remoteHost?: string;
}
export interface DeleteMappingRangeOpts {
    startPort: number;
    endPort: number;
    protocol?: string;
    manage?: boolean;
}
export interface GetMappingRangeOpts {
    startPort: number;
    endPort: number;
    protocol?: string;
    manage?: boolean;
    numberOfPorts?: number;
}
export interface ClientOptions {
    timeout?: number;
    url?: string;
    localAddress?: string;
    cacheGateway?: boolean;
}
export interface IClient {
    url: string | null;
    createMapping(options: NewPortMappingOpts): Promise<RawResponse>;
    createAnyMapping(options: NewPortMappingOpts): Promise<{
        reservedPort: number;
    }>;
    removeMapping(options: DeletePortMappingOpts): Promise<RawResponse>;
    removeMappingRange(options: DeleteMappingRangeOpts): Promise<RawResponse>;
    getMappings(options?: GetMappingOpts): Promise<Mapping[]>;
    getMappingRange(options: GetMappingRangeOpts): Promise<Mapping[]>;
    getMapping(options: GetSpecificMappingOpts): Promise<Mapping | null>;
    getStatusInfo(): Promise<StatusInfo>;
    getPublicIp(): Promise<string>;
    getGateway(): Promise<UpnpInfo>;
    close(): void;
}
