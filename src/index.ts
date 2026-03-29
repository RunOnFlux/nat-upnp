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
 * Raw SOAP response body as parsed by fast-xml-parser.
 * Keys are response element names (e.g., "GetStatusInfoResponse").
 * Values are the parsed child elements. Attributes are prefixed with "@_".
 */
export type RawResponse = Record<string, unknown>;
