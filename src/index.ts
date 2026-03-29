export { Device, UpnpError, xmlParser } from "./nat-upnp/device";
export type {
  GatewayDevice,
  ServiceCapabilities,
  ResolvedService,
  RawService,
  RawDevice,
} from "./nat-upnp/device";

export { Ssdp } from "./nat-upnp/ssdp";
export type { SearchCallback, ISsdp, SsdpEmitter } from "./nat-upnp/ssdp";

export { Client, UpnpInfo } from "./nat-upnp/client";
export type {
  GetMappingOpts,
  GetMappingRangeOpts,
  GetSpecificMappingOpts,
  Mapping,
  StatusInfo,
  DeletePortMappingOpts,
  DeleteMappingRangeOpts,
  NewPortMappingOpts,
  StandardOpts,
  ClientOptions,
} from "./nat-upnp/client";

/**
 * Raw SSDP/UPNP response body (parsed XML).
 */
export type RawResponse = Partial<
  Record<
    string,
    {
      "@": { "xmlns:u": string };
      [key: string]: unknown;
    }
  >
>;
