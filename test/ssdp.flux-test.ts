import { Ssdp } from "../src";
import { setupTest } from "./index.flux-test";

setupTest("NAT-UPNP/Ssdp", (opts) => {
  let client: Ssdp;

  opts.runBefore(() => {
    client = new Ssdp();
  });

  opts.runAfter(() => {
    client.close();
  });

  opts.run("Find router device to Verify uPnP is enabled", async () => {
    const p = client.search(
      "urn:schemas-upnp-org:device:InternetGatewayDevice:1"
    );

    return new Promise((s) => {
      p.on("device", (device) => {
        p.emit("end");
        s(typeof device.location === "string");
      });
    });
  });
});
