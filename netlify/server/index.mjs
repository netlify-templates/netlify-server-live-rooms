// The board's server: the live rooms from ./live, with the board's rules
// (public/board.js) plugged in. Everything that keeps the board consistent is
// in ./live; this file only wires it to Netlify Server.
//
//   GET  /api/live?room=&client=&since=   a room's WebSocket
//   GET  /api/info                        this instance's id, deploy and uptime
//   GET  /api/config                      settings for the pages
//   POST /api/unlock, /api/lock           editing, when EDIT_TOKEN is set (./editors.mjs)
//
// Netlify serves the board's page from public/.
import { onHealthCheck, onShutdown, onStart } from "@netlify/server";

import { applyOp, EMPTY_BOARD } from "../../public/board.js";
import { createDemoBots } from "./demo-bots.mjs";
import { canEdit, lock, locked, unlock } from "./editors.mjs";
import { createLive } from "./live/index.mjs";
import { nameOf } from "./names.mjs";

export const config = {
  path: "/api/*",
};

const live = createLive({ apply: applyOp, initialState: EMPTY_BOARD, nameOf });
const demoBots = createDemoBots(live);

// For the demo's Crash button: exits with no onShutdown and no goodbye to the
// sockets, so clients only find out when their connections drop. Anyone who
// can open the board can press it, so it's off unless ALLOW_CRASH=true, and
// it needs a connection that can edit.
const allowCrash = () => process.env.ALLOW_CRASH === "true";

const onMessage = (message, conn) => {
  if (message.type === "crash" && allowCrash() && !conn.readOnly) {
    console.log(`[${live.info().instance}] crashing on request`);
    process.exit(1);
  }
};

export default async (request) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/live" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return live.connect(request, { onMessage, readOnly: !canEdit(request) });
  }

  if (pathname === "/api/info") {
    return Response.json(live.info(), { headers: { "cache-control": "no-store" } });
  }

  if (pathname === "/api/config") {
    return Response.json({ allowCrash: allowCrash(), locked: locked(), canEdit: canEdit(request) }, { headers: { "cache-control": "no-store" } });
  }

  if (pathname === "/api/unlock") {
    return unlock(request);
  }

  if (pathname === "/api/lock") {
    return lock(request);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

onStart(() => {
  live.start();
  demoBots.start();
});
// The bots stop right away, and the database pool stays open until they've
// let their lease go.
onShutdown(({ drained } = {}) => {
  const botsStopped = demoBots.stop();

  return live.stop({ drained: Promise.all([drained, botsStopped]) });
});
onHealthCheck(() => ({ namedMetrics: { websockets: live.info().sockets } }));
