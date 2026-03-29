# nat-upnp

UPnP port mapping client for Node.js with IGD v1/v2 support, SCPD capability detection, and device info parsing.

Tested against 13 router models across 400+ nodes (OPNsense, pfSense, ASUS, MikroTik, Ubiquiti, TP-Link, Freebox, Nokia, Sagemcom, NEC, Sercomm, Technicolor, Linux IGD).

> This package is published as `@megachips/nat-upnp` for testing. The upstream package is [`@runonflux/nat-upnp`](https://github.com/RunOnFlux/nat-upnp).

## Installation

```bash
npm install @runonflux/nat-upnp
```

## Quick Start

ESM:
```javascript
import { Client } from "@runonflux/nat-upnp";
```

CommonJS:
```javascript
const { Client } = require("@runonflux/nat-upnp");
```

```javascript
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
```

## Gateway Discovery

`getGateway()` discovers the UPnP gateway via SSDP and returns an `UpnpInfo` object. The SSDP socket is created for discovery and automatically closed when done — no cleanup needed.

Device info, capabilities, and local address are fetched lazily on first access, or all at once via `getAll()`:

```typescript
const info = await client.getGateway();

// Option A: resolve everything in one call
const { device, capabilities, localAddress } = await info.getAll();

// Option B: fetch individually (lazy, cached after first call)
const device = await info.getDevice();
const caps = await info.getCapabilities();
const addr = await info.getLocalAddress();
```

### Device Info

```typescript
const device = await info.getDevice();
console.log(device?.manufacturer);         // "FreeBSD"
console.log(device?.modelName);            // "FreeBSD router"
console.log(device?.modelNumber);          // "26.1.3"
console.log(device?.wan?.modelDescription); // "MiniUPnP daemon version 2.3.9"
```

### Service Capabilities

Parsed from the router's SCPD — tells you exactly which SOAP actions are supported:

```typescript
const caps = await info.getCapabilities();
console.log(caps?.serviceType);                        // "urn:...:WANIPConnection:1"
console.log(caps?.serviceVersion);                     // 1
console.log(caps?.actions);                            // ["AddPortMapping", ...]
console.log(caps?.supportsAddAnyPortMapping);          // false
console.log(caps?.supportsGetSpecificPortMappingEntry); // true
```

### Local Address

Resolved via UDP connect (zero-packet kernel route query) — the standard technique used by miniupnpc, Python, Go, Docker, and Kubernetes:

```typescript
const addr = await info.getLocalAddress(); // "192.168.1.100"
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
// Returns Mapping if found, null if not found (714/713), throws UpnpError on other errors

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
const range = await client.getMappingRange({
  startPort: 8000,
  endPort: 9000,
  numberOfPorts: 500,  // max entries to return (default: 1000)
});
```

## SSDP Bypass

If you already know the router's UPnP URL, skip SSDP discovery:

```typescript
const client = new Client({
  url: "http://192.168.1.1:5000/rootDesc.xml",
  localAddress: "192.168.1.100",
});
```

## Error Handling

SOAP errors are thrown as `UpnpError` with numeric codes:

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
| 713 | SpecifiedArrayIndexInvalid |
| 714 | NoSuchEntryInArray |
| 718 | ConflictInMappingEntry |
| 725 | OnlyPermanentLeasesSupported |
| 728 | NoPortMapsAvailable |
| 729 | ConflictWithOtherMechanisms |

`getMappings()` throws if a mid-iteration error occurs (e.g., network failure), so the caller knows they have incomplete data rather than silently receiving partial results. End-of-list signals (714, 713) are handled normally.

## Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `1800` | SSDP discovery timeout (ms) |
| `cacheGateway` | `boolean` | `false` | Cache gateway between calls |
| `url` | `string` | — | Bypass SSDP, connect directly |
| `localAddress` | `string` | — | Required when using `url` |

Port mapping methods accept a `ttl` option (seconds). Default is 1800 (30 minutes). Set to 0 for permanent mappings.

## Resource Management

SSDP sockets are created per gateway discovery and closed automatically when discovery completes. No persistent sockets are held. `close()` is available to signal that the client should not be used further, but forgetting to call it does not leak resources.

```typescript
// Resources are managed automatically
const client = new Client({ cacheGateway: true });
const info = await client.getGateway(); // socket opened, used, closed
await client.createMapping({ ... });     // uses HTTP, no persistent socket

// Optional: signal no further use
client.close();
```

## Security

- XXE protection (`processEntities: false`)
- XML escaping on SOAP argument values
- Response size limits (2MB) and HTTP timeout (10s)
- Redirect limit (2 hops)
- `getMappings` iteration capped at 10,000
- HTTP keepalive disabled (miniupnpd always closes connections)
- SSDP Location header validated (HTTP only)
- Device URL validated on construction

## License

[Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)
