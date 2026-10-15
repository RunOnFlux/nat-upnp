import dgram from "dgram";

/**
 * Determine which local interface address the OS would use to reach a remote IP.
 * Uses UDP connect — a zero-packet kernel route query. No data is sent on the wire.
 * This is the standard technique used by miniupnpc (C), Python's socket module,
 * Go's net.Dial, Docker, and Kubernetes for local address resolution.
 */
export function resolveLocalAddress(remoteIp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error(`resolveLocalAddress timed out for ${remoteIp}`));
      }
    }, 5000);

    socket.connect(80, remoteIp, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      reject(err);
    });
  });
}
