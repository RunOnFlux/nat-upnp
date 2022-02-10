import net from "net";
import { setupTest } from "./index.flux-test";
import { Client } from "../src";
import internal from "stream";

setupTest("NAT-UPNP/Client", (opts) => {
  let client: Client;
  var globalPort:number[] = [0,0,0,0,0];
  var localPort:number[] = [0,0,0,0,0];
  var num_error = 0;
  var i:number;
  for (i=0;i<5;i++) {
    globalPort[i] = ~~(Math.random() * 10000 + 30000); // 30,000 to 40,000
    localPort[i] = ~~(Math.random() * 1000 + 7000); // 7,000 to 8,000
  }

  async function getMapping() {
    try {
      const mappings = await client.getMappings();
      var i:number;
      return mappings;
    } catch (error) {
      console.log("No Ports Mapped");
      return [];
    }
  
  }
  
  opts.runBefore(() => {
    client = new Client();
  });

  opts.runAfter(() => {
    client.close();
  });

  opts.run("Get public ip address", async () => {
    const ip = await client.getPublicIp();
    const gw = await client.getGateway();
    console.log("Public IP %s Gateway IP %s", ip, gw.address);
    console.log(client);
    return net.isIP(ip) !== 0;
  });

  opts.run("Get and clear Port Mappings", async () => {
      await client.createMapping({
        public: 4321,
        private: 5432,
        ttl: 0
      });
    const mappings = await getMapping();
    if (mappings.length == 0) return true;
    for (i=0;i<mappings.length;i++) {
      console.log("Public: ", mappings[i].public.port, " Private: ", mappings[i].private.port, " Host: ", mappings[i].private.host);
      await client.removeMapping({ public: mappings[i].public.port });
    }
    return true;
  });
  
  opts.run("Port mappings cleared", async () => {
    var passed:boolean;
    passed = true;
    const mappings = await getMapping();
    console.log("Mapping size ", mappings.length, mappings);
    if (mappings.length == 0) return true;
    for (i=0;i<mappings.length;i++) {
       console.log("Public: ", mappings[i].public.port, " Private: ", mappings[i].private.port, " Host: ", mappings[i].private.host);
       passed = false;
    }
    return passed;
  });
  
  opts.run("Port mapping", async () => {
    var i:number;
    for (i=0;i<5;i++) {
      console.log("%d:Map Random port %d to Local Port %d", i+1, globalPort[i], localPort[i]);
      await client.createMapping({
        public: globalPort[i],
        private: localPort[i],
        ttl: 0
      });
    }
    return true;
  });

  opts.run("Find port after mapping", async () => {
    var i:number;
    var passed:boolean;
    const mappings = await getMapping();

    passed = true;
    for (i=0;i<5;i++) {
      var found = mappings.some((mapping) => mapping.public.port === globalPort[i]);
      console.log("Port %d found ", globalPort[i],found);
      if (!found) passed = false;
    }
    return passed;
  });


opts.run("Port unmapping", async () => {
  var i:number;
  for (i=0;i<5;i++) {
    console.log("Remove Mapping for %d", globalPort[i]);
    await client.removeMapping({ public: globalPort[i] });
  }
  return true;
});

  opts.run("Verify port unmapping", async () => {
    var i:number;
    var passed:boolean;
    const mappings = await getMapping();
    console.log("Mapping size ", mappings.length, mappings);

    passed = true;
    for (i=0;i<5;i++) {
      var found = mappings.some((mapping) => mapping.public.port === globalPort[i]);
      console.log("Port %d found ", globalPort[i],found);
      if (found) passed = false;
    }
    return passed;
  });
});
