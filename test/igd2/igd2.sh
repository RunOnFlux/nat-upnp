#!/usr/bin/env bash
#
# Stand up a disposable IGDv2 gateway in Docker and run the integration suite
# against it.
#
#   ./test/igd2/igd2.sh run     both IGD versions, end to end   (npm run flux-test:igd2)
#   ./test/igd2/igd2.sh up      build images, create the networks, start the gateway
#   ./test/igd2/igd2.sh up --v1 the same gateway reporting IGDv1, for the other branch
#   ./test/igd2/igd2.sh test    run the integration suite from a client container
#   ./test/igd2/igd2.sh shell   interactive shell on the LAN, suite mounted
#   ./test/igd2/igd2.sh logs    follow the gateway's miniupnpd -d output
#   ./test/igd2/igd2.sh down    remove the containers and networks
#
# Everything lives in its own network namespace: the gateway rewrites nftables
# rules inside its own container, never the host's.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

LAN_NET=natupnp-lan
WAN_NET=natupnp-wan
LAN_SUBNET=192.168.211.0/24
WAN_SUBNET=198.51.100.0/24     # RFC 5737 TEST-NET-2, never routed
GW_LAN_IP=192.168.211.2
GW_WAN_IP=198.51.100.2
GW_NAME=natupnp-igd2-gw
GW_IMAGE=natupnp-igd2-gateway
CLIENT_IMAGE=natupnp-igd2-client
HTTP_PORT=5000

DESCRIPTION_URL="http://${GW_LAN_IP}:${HTTP_PORT}/rootDesc.xml"

ensure_network() {
  local name=$1 subnet=$2
  if ! docker network inspect "$name" >/dev/null 2>&1; then
    docker network create --subnet "$subnet" "$name" >/dev/null
    echo "created network $name ($subnet)"
  fi
}

cmd_up() {
  # miniupnpd's force_igd_desc_v1 keeps the same binary but advertises IGDv1
  # and WANIPConnection:1, whose SCPD drops the three v2 actions — which is how
  # the "not supported" branch gets exercised without a second router.
  local force_v1=no
  [ "${1:-}" = "--v1" ] && force_v1=yes

  docker build -q -t "$GW_IMAGE" -f "$HERE/Dockerfile.gateway" "$HERE" >/dev/null
  docker build -q -t "$CLIENT_IMAGE" -f "$HERE/Dockerfile.client" "$HERE" >/dev/null

  ensure_network "$LAN_NET" "$LAN_SUBNET"
  ensure_network "$WAN_NET" "$WAN_SUBNET"

  docker rm -f "$GW_NAME" >/dev/null 2>&1 || true

  # Create, attach the WAN leg, then start: miniupnpd reads both interfaces at
  # boot, so eth1 has to exist before the entrypoint runs.
  docker create \
    --name "$GW_NAME" \
    --cap-add NET_ADMIN \
    --cap-add NET_RAW \
    --sysctl net.ipv4.ip_forward=1 \
    --network "$LAN_NET" --ip "$GW_LAN_IP" \
    -e LAN_IP="$GW_LAN_IP" -e WAN_IP="$GW_WAN_IP" -e HTTP_PORT="$HTTP_PORT" \
    -e FORCE_IGD_V1="$force_v1" \
    "$GW_IMAGE" >/dev/null

  docker network connect --ip "$GW_WAN_IP" "$WAN_NET" "$GW_NAME"
  docker start "$GW_NAME" >/dev/null

  for _ in $(seq 1 30); do
    if docker run --rm --network "$LAN_NET" "$CLIENT_IMAGE" \
         node -e "require('http').get('$DESCRIPTION_URL', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" \
         >/dev/null 2>&1; then
      echo "gateway up: $DESCRIPTION_URL (IGDv$([ "$force_v1" = yes ] && echo 1 || echo 2))"
      return 0
    fi
    sleep 1
  done

  echo "gateway did not answer on $DESCRIPTION_URL" >&2
  docker logs "$GW_NAME" >&2
  return 1
}

cmd_test() {
  docker run --rm \
    --network "$LAN_NET" \
    --cap-add NET_ADMIN \
    --cap-add NET_RAW \
    -v "$REPO:/work" \
    -w /work \
    -e FLUX_UPNP_DISPOSABLE_GATEWAY=1 \
    "$CLIENT_IMAGE" \
    node ./build/test/index.flux-test.js
}

cmd_shell() {
  docker run --rm -it \
    --network "$LAN_NET" \
    --cap-add NET_ADMIN \
    --cap-add NET_RAW \
    -v "$REPO:/work" \
    -w /work \
    "$CLIENT_IMAGE" bash
}

cmd_logs() { docker logs -f "$GW_NAME"; }

# Both IGD versions in one go. A failing run leaves the gateway and its logs
# standing — tearing down here would destroy the evidence for whatever failed.
cmd_run() {
  local failed=0
  for mode in "" "--v1"; do
    echo
    echo "########## integration suite against $([ -n "$mode" ] && echo IGDv1 || echo IGDv2)"
    cmd_up "$mode"
    cmd_test || failed=1
    if [ "$failed" = 1 ]; then
      echo "suite failed — gateway left up. './test/igd2/igd2.sh logs' for miniupnpd output," >&2
      echo "'./test/igd2/igd2.sh down' when you are done with it." >&2
      return 1
    fi
  done
  cmd_down
}

cmd_down() {
  docker rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker network rm "$LAN_NET" "$WAN_NET" >/dev/null 2>&1 || true
  echo "torn down"
}

case "${1:-}" in
  run)   cmd_run ;;
  up)    cmd_up "${2:-}" ;;
  test)  cmd_test ;;
  shell) cmd_shell ;;
  logs)  cmd_logs ;;
  down)  cmd_down ;;
  url)   echo "$DESCRIPTION_URL" ;;
  *) sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
