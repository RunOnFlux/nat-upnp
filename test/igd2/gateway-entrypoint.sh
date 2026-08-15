#!/bin/sh -e
#
# Bring up miniupnpd as an IGDv2 gateway inside this container's own network
# namespace. LAN_IF faces the test client; WAN_IF is the pretend uplink whose
# address is reported as the public IP.

HTTP_PORT=${HTTP_PORT:-5000}
FORCE_IGD_V1=${FORCE_IGD_V1:-no}

# The names are what the suite prints back, so they should say which mode the
# same binary is running in.
if [ "$FORCE_IGD_V1" = yes ]; then IGD_VERSION=1; else IGD_VERSION=2; fi
FRIENDLY_NAME=${FRIENDLY_NAME:-Flux IGDv$IGD_VERSION Test Gateway}

# Find each leg by the address it was pinned to, never by interface name.
# Docker does not promise that the network given to `create` becomes eth0 and a
# later `network connect` becomes eth1 — the order varies between starts of the
# same container, and a swapped pair points miniupnpd's uplink at its own LAN.
iface_for_ip() {
  ip -4 -o addr show 2>/dev/null | awk -v want="$1" '$4 ~ "^"want"/" { print $2; exit }'
}

if [ -z "${LAN_IP:-}" ] || [ -z "${WAN_IP:-}" ]; then
  echo "LAN_IP and WAN_IP must both be set — they are how the legs are identified" >&2
  exit 1
fi

LAN_IF=$(iface_for_ip "$LAN_IP")
WAN_IF=$(iface_for_ip "$WAN_IP")

if [ -z "$LAN_IF" ] || [ -z "$WAN_IF" ]; then
  echo "expected LAN $LAN_IP and WAN $WAN_IP; both networks must be attached before start" >&2
  ip -4 -o addr show >&2
  exit 1
fi

cat > /etc/miniupnpd/miniupnpd.conf <<EOF
ext_ifname=$WAN_IF
listening_ip=$LAN_IF
http_port=$HTTP_PORT
enable_upnp=yes
enable_pcp_pmp=yes
secure_mode=no
system_uptime=yes
notify_interval=30
uuid=$(uuidgen)
serial=$(cat /sys/class/net/"$LAN_IF"/address | tr -d ':')
model_number=$IGD_VERSION
friendly_name=$FRIENDLY_NAME
manufacturer_name=RunOnFlux
manufacturer_url=https://runonflux.io/
model_name=IGDv$IGD_VERSION Test Gateway
model_description=Debian miniupnpd built with IGD_V2
model_url=https://runonflux.io/
bitrate_up=1000000
bitrate_down=10000000
force_igd_desc_v1=$FORCE_IGD_V1
allow 0-65535 0.0.0.0/0 0-65535
# The WAN leg sits in RFC 5737 documentation space so it can never be routed
# anywhere. miniupnpd's reserved table (getifaddr.c) covers all three TEST-NET
# blocks, and on a reserved external address it sets disable_port_forwarding —
# every AddPortMapping then fails 501 with no error of its own, having said so
# once at startup — and reports an empty NewExternalIPAddress. Declaring the
# address keeps the documentation range and still yields a usable public IP.
ext_ip=$WAN_IP
ext_allow_private_ipv4=yes
EOF

echo "== miniupnpd.conf =="
cat /etc/miniupnpd/miniupnpd.conf
echo "== interfaces =="
echo "  LAN $LAN_IF $LAN_IP"
echo "  WAN $WAN_IF $WAN_IP"

/etc/miniupnpd/nft_init.sh

echo "== description URL: http://$LAN_IP:$HTTP_PORT/rootDesc.xml =="

exec miniupnpd -d -f /etc/miniupnpd/miniupnpd.conf
