# nat-upnp

UPnP port mapping client for Node.js with IGD v1/v2 support, SCPD capability detection, and device info parsing.

Tested against 73 routers, from 1014 captured responses: 13 curated models (OPNsense, pfSense, ASUS, MikroTik, Ubiquiti, TP-Link, Freebox, Nokia, Sagemcom, NEC, Sercomm, Technicolor, Linux IGD) and 60 drawn from a survey of 820 UPnP gateways on the Flux network.


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

### Caching the Gateway

With `cacheGateway: true` the gateway found by the first discovery is kept for later calls. A request to it that fails with anything but a UPnP fault - a connection refused or reset, no answer within the request timeout, an answer that is not a SOAP reply - drops it and searches again, since a router whose UPnP service restarts answers on a new port. If the router now answers at a different location, the request is sent there once more; at the same location the original error stands. A UPnP fault, an action the router does not support, and an abort by the caller keep the cached gateway.

A request sent again may find that the first one landed before the router went quiet. `createMapping` then gets 718 for its own mapping, and resolves if the router holds exactly that mapping (same internal client, internal port and description). `removeMapping` gets 714, and `removeMappingRange` 714 or 730, and they resolve. On a first request each of these codes throws as usual. `createAnyMapping` is never sent twice, because the router picks its port.

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

Available only if the router advertises them in its SCPD. Throws `UnsupportedActionError` when the router's SCPD does not list the action, and `CapabilityUnavailableError` when the SCPD cannot be read; the next call reads it again.

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

## Cancelling a Request

Every method that talks to the router takes a `signal` (an `AbortSignal`) with its options; `getStatusInfo`, `getPublicIp` and `getGateway` take it as `{ signal }`. Aborting it cancels the request: one not yet sent is never sent, one in flight has its socket closed, and the call rejects with `signal.reason`. A `getMappings` walk stops at the entry in flight and rejects; it never answers with the entries it read before the abort.

```typescript
// Give the whole walk 75 seconds, however many entries the table holds.
const mine = await client.getMappings({ local: true, signal: AbortSignal.timeout(75_000) });

const controller = new AbortController();
const pending = client.removeMapping({ public: 8080, signal: controller.signal });
controller.abort(); // pending rejects with controller.signal.reason
```

The gateway, its description and its capabilities are fetched once and shared between concurrent calls. Aborting one call ends only that call's wait for them; the fetch runs on for the others.

## Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | `number` | `1800` | SSDP discovery timeout (ms) |
| `cacheGateway` | `boolean` | `false` | Keep the discovered gateway between calls; see [Caching the Gateway](#caching-the-gateway) |
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

## Testing

```sh
npm run test            # unit suite, against 73 captured routers
npm run flux-test:igd2  # integration suite, against a gateway in Docker
```

Both run in CI on every push. The integration suite stands its own IGD gateway up in a container and runs against IGD v2 and then IGD v1 — see [test/igd2](test/igd2/README.md).

`npm run flux-test` runs that same integration suite against **whatever real router the machine sits behind**, discovered over SSDP. It is a diagnostic for investigating one specific router, not part of the test plan, and it is not routine:

- it creates and deletes port mappings in that router's table
- one testcase adds an `iptables` rule blocking outbound SSDP on the host and removes it in a `finally`; kill the process at the wrong moment and the rule stays
- it needs root, and it hangs rather than failing where there is no UPnP gateway at all

Point it at a router deliberately, on a machine you are willing to have it touch.

## License

[Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)
