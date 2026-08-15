# A disposable IGD gateway for the integration suite

This is the integration test. It stands a gateway up in Docker, so the suite runs on a workstation
and in CI, and — more to the point — against an **IGDv2** router, which the v2 code paths had
never met.

The suite can also be pointed at a real router with `npm run flux-test`, but that is a diagnostic
for one specific router rather than something to run routinely: it writes to that router's mapping
table and adds a temporary `iptables` rule on the host. Prefer this.

```sh
npm run flux-test:igd2
```

That builds both images, creates the networks, and runs the suite against IGDv2 and then IGDv1 —
the same daemon reporting a v1 description, which is how the "not supported" branch of the
capability gate gets exercised. Both modes pass.

After a clean run it removes the container and both networks. It **leaves the gateway standing
after a failure**, so `igd2.sh logs` still has the miniupnpd output for whatever broke.

The two images it builds are left in place — about 400 MB, and they are the whole reason a second
run is quick, since they carry the Debian package installs. Nothing is running and nothing holds
an address; remove them with `docker rmi natupnp-igd2-gateway natupnp-igd2-client` when you want
the space back.

`igd2.sh up [--v1]`, `test`, `shell`, `logs` and `down` drive the same thing by hand.

## What it is

Debian's `miniupnpd` package is built `--igd2` (see `CONFIG_ARGS` in its `debian/rules`), so the
stock binary advertises `InternetGatewayDevice:2` / `WANIPConnection:2` and carries
`AddAnyPortMapping`, `DeletePortMappingRange` and `GetListOfPortMappings`. No compilation is
needed. `force_igd_desc_v1` flips the same binary back to a v1 description — which is why
OPNsense reports v1 on the same miniupnpd 2.3.9 that three FreeBSD routers in the fleet survey
report v2 on.

Two containers on two user-defined bridges:

- `natupnp-lan` (192.168.211.0/24) — the client and the gateway's LAN leg
- `natupnp-wan` (198.51.100.0/24) — the gateway's pretend uplink

The gateway rewrites nftables rules **inside its own network namespace**, never the host's. SSDP
multicast crosses the Docker bridge, so discovery is exercised for real rather than bypassed.

## Two things worth knowing before changing it

**The WAN leg is in RFC 5737 documentation space, and miniupnpd refuses to forward for one.**
Its reserved table (`getifaddr.c`) covers all three TEST-NET blocks, RFC 1918, RFC 6598 and
RFC 2544. On a reserved external address it sets `disable_port_forwarding`, and that is the one
path in `upnp_redirect_internal` that returns -1 **without logging anything** — every
`AddPortMapping` comes back `501 Action Failed` with no cause, and `GetExternalIPAddress` returns
an empty string. It does say so once, at startup. `ext_ip` plus `ext_allow_private_ipv4` keeps the
documentation range and still reports a usable public IP.

**Both firewall backends work.** `miniupnpd-nftables` matches trixie's default and is what this
uses. `miniupnpd-iptables` uses libiptc, which talks to the *legacy* tables while `iptables` on
trixie is `iptables-nft` — so the init script populates one set of tables and the daemon reads the
other, and the daemon says `chain MINIUPNPD not found`. Set the alternative to `iptables-legacy`
before running `iptables_init.sh` if you ever need that variant.

## Limits

The gateway does not route traffic — nothing is sent through a mapping. The suite asserts on what
the router reports, which is what the library parses.
