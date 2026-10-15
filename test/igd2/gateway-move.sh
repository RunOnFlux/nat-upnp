#!/bin/bash -e
#
# Restarts miniupnpd on whichever of its two HTTP ports it is not on now - the
# base port and the one above it - and answers the connection that asked with
# the new description URL once miniupnpd is listening there.
#
#   gateway-move.sh <lan ip> <base http port>

LAN_IP=$1
BASE_PORT=$2
CONF=/etc/miniupnpd/miniupnpd.conf

current=$(sed -n 's/^http_port=//p' "$CONF")
if [ "$current" = "$BASE_PORT" ]; then next=$((BASE_PORT + 1)); else next=$BASE_PORT; fi

PIDFILE=/var/run/miniupnpd.pid
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  kill "$pid" 2>/dev/null || true
  while [ -d "/proc/$pid" ]; do sleep 0.1; done
fi

sed -i "s/^http_port=.*/http_port=$next/" "$CONF"
echo "== moving to http://$LAN_IP:$next/rootDesc.xml ==" > /proc/1/fd/1
setsid miniupnpd -d -f "$CONF" > /proc/1/fd/1 2>&1 < /dev/null &

for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/$LAN_IP/$next") 2>/dev/null; then
    echo "http://$LAN_IP:$next/rootDesc.xml"
    exit 0
  fi
  sleep 0.1
done
echo "miniupnpd did not come up on port $next" >&2
exit 1
