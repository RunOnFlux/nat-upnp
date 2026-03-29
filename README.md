# nat-upnp

UPnP port mapping client for Node.js with IGD v1/v2 support, SCPD capability detection, and device info parsing.

Tested against 13 router models across 400+ nodes (OPNsense, pfSense, ASUS, MikroTik, Ubiquiti, TP-Link, Freebox, Nokia, Sagemcom, NEC, Sercomm, Technicolor, Linux IGD).

> This package is published as `@megachips/nat-upnp` for testing. The upstream package is [`@runonflux/nat-upnp`](https://github.com/RunOnFlux/nat-upnp).

## Installation

```bash
npm install @runonflux/nat-upnp
```

## Quick Start

```typescript
import { Client } from "@runonflux/nat-upnp";

const client = new Client({ cacheGateway: true });

// Create a port mapping
await client.createMapping({
  public: 8080,
  private: 8080,
  description: "My App",
  ttl: 3600,
});

// Check if a specific mapping exists (O(1) lookup)
const mapping = await client.getMapping({ public: 8080, protocol: "TCP" });

// Remove it
await client.removeMapping({ public: 8080 });

client.close();
```

## Gateway Discovery

`getGateway()` discovers the UPnP gateway via SSDP and returns an `UpnpInfo` object. Device info and capabilities are fetched lazily on first access.

```typescript
const info = await client.getGateway();

// Local address resolved via UDP connect (zero-packet kernel route query)
const localAddr = await info.getLocalAddress();

// Device info from rootDesc.xml
const device = await info.getDevice();
console.log(device?.manufacturer);
console.log(device?.modelName);
console.log(device?.wan?.modelDescription); // e.g. "MiniUPnP daemon version 2.3.9"

// Service capabilities from SCPD
const caps = await info.getCapabilities();
console.log(caps?.serviceType);                        // "urn:...:WANIPConnection:1"
console.log(caps?.actions);                            // ["AddPortMapping", ...]
console.log(caps?.supportsAddAnyPortMapping);          // false
console.log(caps?.supportsGetSpecificPortMappingEntry); // true
```

## Port Mapping

```typescript
// Create
await client.createMapping({
  public: 8080,
  private: 8080,        // defaults to public if omitted
  protocol: "TCP",      // default
  description: "My App",
  ttl: 3600,            // seconds, 0 = permanent
});

// Remove
await client.removeMapping({ public: 8080 });

// Query specific port (O(1) — single SOAP call)
const mapping = await client.getMapping({ public: 8080, protocol: "TCP" });
// Returns Mapping or null

// List all
const all = await client.getMappings();
const local = await client.getMappings({ local: true });
const filtered = await client.getMappings({ description: /^Flux_/ });
```

## Network Info

```typescript
const ip = await client.getPublicIp();
const status = await client.getStatusInfo();
// { connectionStatus: "Connected", uptime: 86400, lastConnectionError: "ERROR_NONE" }
```

## IGD v2 Actions

Available only if the router advertises them in its SCPD. Throws `UpnpError` (code 401) if not supported.

```typescript
// Router assigns port if requested one is taken
const result = await client.createAnyMapping({ public: 8080, ttl: 3600 });
console.log(result.reservedPort);

// Bulk operations
await client.removeMappingRange({ startPort: 8000, endPort: 9000 });
const range = await client.getMappingRange({ startPort: 8000, endPort: 9000 });
```

## SSDP Bypass

```typescript
const client = new Client({
  url: "http://192.168.1.1:5000/rootDesc.xml",
  localAddress: "192.168.1.100",
});
```

## Error Handling

```typescript
import { UpnpError } from "@runonflux/nat-upnp";

try {
  await client.createMapping({ public: 8080, ttl: 60 });
} catch (err) {
  if (err instanceof UpnpError) {
    console.log(err.code);        // 725
    console.log(err.description);  // "OnlyPermanentLeasesSupported"
    console.log(err.action);       // "AddPortMapping"
  }
}
```

| Code | Description |
|------|-------------|
| 402 | Invalid Args |
| 501 | Action Failed |
| 606 | Action Not Authorized |
| 714 | NoSuchEntryInArray |
| 718 | ConflictInMappingEntry |
| 725 | OnlyPermanentLeasesSupported |

## Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `1800` | SSDP discovery timeout (ms) |
| `cacheGateway` | `boolean` | `false` | Cache gateway between calls |
| `url` | `string` | — | Bypass SSDP, connect directly |
| `localAddress` | `string` | — | Required when using `url` |

## Security

- XXE protection (`processEntities: false`)
- XML escaping on SOAP argument values
- Response size limits (2MB)
- `getMappings` iteration capped at 10,000
- HTTP keepalive disabled (miniupnpd always closes connections)

## License

[Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)
