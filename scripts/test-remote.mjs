// The failover test against a real deploy on Netlify. Three clients keep
// writing while this script:
//   1. runs `netlify deploy --prod`, has a new client join the new deploy,
//      and waits for the old instance to shut down;
//   2. crashes the live instance and waits for everyone to reconnect.
// It has no access to the database, so it uses the first client's events as
// the record of what was committed: that client joined before anyone wrote,
// so it saw every event.
//
// The deploy has to change the server's bundle, or the platform keeps the
// running instance. Change the server's code before running this (a comment
// isn't enough, since the bundler drops comments). The site also needs
// ALLOW_CRASH=true.
//
// It deploys this folder to the site the URL belongs to.
//
//   npm run test:remote -- https://<site>.netlify.app
import { execFileSync, spawn } from "node:child_process";

import { checker, checkResults, sleep, TestClient, waitFor } from "./lib/client.mjs";

const site = process.argv[2];

if (!site) {
  console.error("Usage: npm run test:remote -- https://<site>.netlify.app");
  process.exit(1);
}

const ROOM = `remote-${Date.now().toString(36)}`;
const url = `${site.replace(/^http/, "ws")}/api/live`;
const startedAt = Date.now();
const say = (text) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)} s] ${text}`);
const info = async () => (await fetch(`${site}/api/info`, { cache: "no-store" })).json();

if (!(await (await fetch(`${site}/api/config`)).json()).allowCrash) {
  console.error("The site doesn't allow crashes. Set ALLOW_CRASH=true on it (netlify env:set ALLOW_CRASH true) and deploy.");
  process.exit(1);
}
// Deploys go to this site, whichever site the folder is linked to. The API
// finds a site by any of its hostnames.
const siteId = JSON.parse(execFileSync("netlify", ["api", "getSite", "--data", JSON.stringify({ site_id: new URL(site).hostname })], { encoding: "utf8" })).id;
const { check, failures } = checker();

let writing = true;
const clients = [new TestClient("ana", { url, room: ROOM }), new TestClient("ben", { url, room: ROOM })];
const [ana, ben] = clients;
// About 5 changes a second per client.
const write = (client) => client.write(() => writing, 200);

await waitFor(() => clients.every((client) => client.ready), 60_000, "the first clients");

// The platform can run more than one instance of a deploy, so
// each client is checked against the instance it started on.
const oldInstances = [ana.instance, ben.instance];
const oldDeploy = ana.deploy;
const onOldInstances = () => ana.instance === oldInstances[0] && ben.instance === oldInstances[1];

say(`Room ${ROOM}: ana is on instance ${oldInstances[0]}, ben on ${oldInstances[1]} (deploy ${oldDeploy.slice(0, 8)}), NOTIFY ${ana.room.server.notify ? "on" : "off"}`);
clients.forEach(write);

// 1. Deploy.
say("Running netlify deploy --prod");

const deployed = await new Promise((resolve) => {
  const child = spawn("netlify", ["deploy", "--prod", "--site", siteId], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";

  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("exit", (code) => resolve({ code, output }));
});

if (deployed.code !== 0) {
  console.log(deployed.output);
  process.exit(1);
}

const liveAt = Date.now();
const now = await info();

say(`The deploy is live; /api/info is answered by instance ${now.instance}`);

if (oldInstances.includes(now.instance)) {
  console.log("\nThe platform kept the running instance, so the bundle didn't change. Change the server's code (comments don't count, the bundler drops them) and run this again.");
  process.exit(1);
}

const cara = new TestClient("cara", { url, room: ROOM });

clients.push(cara);
await waitFor(() => cara.ready, 60_000, "cara");
write(cara);
say(`cara joined instance ${cara.instance} (deploy ${cara.deploy.slice(0, 8)})`);
check(cara.deploy !== oldDeploy, "a client that joins after the deploy gets the new deploy");
check(onOldInstances(), "clients that joined before the deploy are still on the old deploy's instances");

await sleep(10_000);
check(!onOldInstances() || ana.eventsFrom.has(cara.instance), "a client on the old deploy gets writes made on the new one");
check(!onOldInstances() || cara.eventsFrom.has(oldInstances[0]), "a client on the new deploy gets writes made on the old one");

say("Waiting for the old deploy's instances to shut down (up to 10 minutes)");
await waitFor(() => ana.deploy !== oldDeploy && ben.deploy !== oldDeploy && ana.ready && ben.ready, 600_000, "the old instances' clients to move");
say(`The old instance's clients moved ${((Date.now() - liveAt) / 1000).toFixed(0)} s after the deploy went live`);
check(
  ana.deploy === cara.deploy && ben.deploy === cara.deploy,
  `the old instance's clients reconnected to the new deploy (${ana.instance}, ${ben.instance} and cara on ${cara.instance})`,
);

// 2. Crash.
const crashed = cara.instance;
const crashedAt = Date.now();

say(`Crashing instance ${crashed}`);
// Sent once cara has a connection that can take it.
check(await waitFor(() => cara.room.send({ type: "crash" }), 10_000, "a connection to send the crash on"), "the crash was sent");
await sleep(1_000);
await waitFor(() => clients.every((client) => client.ready && client.instance !== crashed), 300_000, "reconnects after the crash");
say(`Everyone reconnected ${((Date.now() - crashedAt) / 1000).toFixed(0)} s after the crash, to instance ${cara.instance}`);
check(
  clients.every((client) => client.instance !== crashed),
  "after a crash, clients reconnect to a new instance",
);

await sleep(5_000);
writing = false;
await waitFor(() => clients.every((client) => client.ready && client.room.pending.length === 0), 60_000, "outboxes to empty");
await waitFor(() => clients.every((client) => client.version === ana.version), 15_000, "everyone to reach the last version");

console.log("\nResults");
checkResults(check, clients, { version: ana.version, state: ana.room.confirmed.state, ids: ana.seen });

console.log(`\nAfter: ${JSON.stringify(await info())}`);
clients.forEach((client) => client.room.close());

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll checks passed.");
process.exit(0);
