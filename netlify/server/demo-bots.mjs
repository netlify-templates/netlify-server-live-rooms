// Simulated users that run on the server, so a site's demo board looks alive
// without anyone's tab open. Set DEMO_BOTS to the kinds to run (from
// public/bots.js), say DEMO_BOTS=writer,tidy, and DEMO_BOTS_ROOM to the room
// (the demo board by default). They act at the calm pace.
//
// They run only while someone is watching the room, and on one instance at a
// time: every few seconds, an instance with viewers in the room takes or
// renews a lease in the database, and runs the bots while it holds it. An
// instance with no viewers there lets the lease go, so another one can take
// over. Its viewers keep the instance running, which a server's own work
// doesn't.
//
// Each bot is a LiveRoom on a loopback socket into this instance, so its
// changes go through the same protocol and commits as everyone else's.
import { Bot, KINDS } from "../../public/bots.js";
import { every } from "./live/every.mjs";
import * as store from "./live/store.mjs";

const LEASE = "demo-bots";
const LEASE_SECONDS = 20;
const CHECK_MS = 5_000;

export const createDemoBots = (live) => {
  const kinds = (process.env.DEMO_BOTS ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind) => Object.hasOwn(KINDS, kind))
    .slice(0, 3);
  const room = process.env.DEMO_BOTS_ROOM || "demo";
  const holder = crypto.randomUUID();
  let bots = [];
  let holding = false;
  let stopped = false;
  let stopLoop;

  const watched = () => {
    const mine = new Set(bots.map((bot) => bot.room.client));

    return live.clients(room).some((client) => !mine.has(client));
  };

  const startBots = () => {
    const WebSocket = live.loopback();

    bots = kinds.map((kind) => new Bot({ url: "/api/live", room, kind, speed: "calm", lifetime: Infinity, WebSocket }));
    console.log(`[${live.info().instance}] running ${kinds.join(", ")} in ${room}`);
  };

  const stopBots = () => {
    bots.forEach((bot) => bot.remove());
    bots = [];
  };

  // The bots stop before the lease goes, and whenever this instance isn't
  // sure it still holds it (a renewal that failed), so two instances never
  // run them at once.
  const check = async () => {
    if (watched()) {
      try {
        holding = await store.takeLease(LEASE, holder, LEASE_SECONDS);
      } catch (error) {
        holding = false;
        stopBots();
        throw error;
      }
    } else if (holding) {
      holding = false;
      stopBots();
      await store.releaseLease(LEASE, holder);
    }

    if (holding && !stopped && bots.length === 0) {
      startBots();
    } else if (!holding && bots.length > 0) {
      stopBots();
    }
  };

  const start = () => {
    if (kinds.length > 0) {
      stopLoop = every(CHECK_MS, check);
    }
  };

  // Stops the bots right away, so they don't try to reconnect to the live
  // rooms as those stop. The promise lets the lease go, so another instance
  // can take over without waiting for it to expire: the database pool has to
  // stay open until it's done.
  const stop = async () => {
    stopped = true;
    stopBots();

    const turn = stopLoop?.();

    await turn;
    stopBots();
    if (holding) {
      holding = false;
      await store.releaseLease(LEASE, holder).catch(() => {});
    }
  };

  return { start, stop };
};
