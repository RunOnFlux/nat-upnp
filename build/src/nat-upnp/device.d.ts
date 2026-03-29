import { XMLParser } from "fast-xml-parser";
import { RawResponse } from "../index";
export declare const xmlParser: XMLParser;
export declare class Device implements IDevice {
    readonly description: string;
    readonly services: string[];
    private descriptionPromise;
    private servicePromise;
    private deviceInfoPromise;
    private capabilitiesPromise;
    private localAddressPromise;
    constructor(url: string);
    /**
     * Fetch and parse the root device description XML.
     * Concurrent calls share one promise.
     */
    private fetchDescription;
    /**
     * Determine the local interface address used to reach this device.
     * Uses UDP connect (zero-packet kernel route query) — the standard technique
     * used by miniupnpc, Python, Go, Docker, and Kubernetes.
     * Cached after first call.
     */
    getLocalAddress(): Promise<string>;
    /**
     * Parse device info from rootDesc.xml. Returns null on failure.
     */
    getDeviceInfo(): Promise<GatewayDevice | null>;
    private buildDeviceInfo;
    /**
     * Fetch and parse the SCPD to discover supported actions. Returns null on failure.
     */
    getCapabilities(): Promise<ServiceCapabilities | null>;
    private buildCapabilities;
    /**
     * Resolve the service control URL. Prefers v2 > v1 > PPP.
     */
    private resolveService;
    private buildResolvedService;
    getService(types: string[]): Promise<ResolvedService>;
    run(action: string, args: (string | number)[][]): Promise<RawResponse>;
    parseDescription(info: {
        device?: RawDevice;
    }): {
        services: RawService[];
        devices: RawDevice[];
    };
}
export default Device;
export declare class UpnpError extends Error {
    readonly code: number;
    readonly description: string;
    readonly action: string;
    constructor(code: number, description: string, action: string);
}
export interface GatewayDevice {
    friendlyName: string;
    manufacturer: string;
    manufacturerURL: string;
    modelDescription: string;
    modelName: string;
    modelNumber: string;
    modelURL: string;
    serialNumber: string;
    UDN: string;
    presentationURL: string;
    specVersion: {
        major: number;
        minor: number;
    };
    configId: string | null;
    descriptionURL: string;
    wan?: {
        manufacturer: string;
        modelDescription: string;
        modelName: string;
        modelNumber: string;
    };
}
export interface ServiceCapabilities {
    serviceType: string;
    serviceVersion: number;
    controlURL: string;
    actions: string[];
    supportsAddAnyPortMapping: boolean;
    supportsDeletePortMappingRange: boolean;
    supportsGetListOfPortMappings: boolean;
    supportsGetSpecificPortMappingEntry: boolean;
    supportsGetStatusInfo: boolean;
}
export interface ResolvedService {
    service: string;
    SCPDURL: string;
    controlURL: string;
}
export interface RawService {
    serviceType: string;
    serviceId: string;
    controlURL?: string;
    eventSubURL?: string;
    SCPDURL?: string;
}
export interface RawDevice {
    deviceType: string;
    presentationURL: string;
    friendlyName: string;
    manufacturer: string;
    manufacturerURL: string;
    modelDescription: string;
    modelName: string;
    modelNumber: string;
    modelURL: string;
    serialNumber: string;
    UDN: string;
    UPC: string;
    serviceList?: {
        service: RawService | RawService[];
    };
    deviceList?: {
        device: RawDevice | RawDevice[];
    };
}
export interface IDevice {
    getService(types: string[]): Promise<ResolvedService>;
    getDeviceInfo(): Promise<GatewayDevice | null>;
    getCapabilities(): Promise<ServiceCapabilities | null>;
    getLocalAddress(): Promise<string>;
    parseDescription(info: {
        device?: RawDevice;
    }): {
        services: RawService[];
        devices: RawDevice[];
    };
    run(action: string, kvpairs: (string | number)[][]): Promise<RawResponse>;
}
