// The board's server: the live rooms from ./live, with the board's rules
// (public/board.js) plugged in. Everything that keeps the board consistent is
// in ./live; this file only wires it to Netlify Server.
//
//   GET /api/live?room=&client=&author=&since=   a room's WebSocket
//   GET /api/info                                this instance's id, deploy and uptime
//   GET /api/config                              settings for the pages
//
// Netlify serves the board's page from public/.
import { onHealthCheck, onShutdown, onStart } from "@netlify/server";

import { applyOp, EMPTY_BOARD } from "../../public/board.js";
import { createLive } from "./live/index.mjs";

export const config = {
  path: "/api/*",
};

const live = createLive({ apply: applyOp, initialState: EMPTY_BOARD });

// For the demo's Crash button: exits with no onShutdown and no goodbye to the
// sockets, so clients only find out when their connections drop. Anyone who
// can open the board can press it, so it's off unless ALLOW_CRASH=true.
const allowCrash = () => process.env.ALLOW_CRASH === "true";

const onMessage = (message) => {
  if (message.type === "crash" && allowCrash()) {
    console.log(`[${live.info().instance}] crashing on request`);
    process.exit(1);
  }
};

export default async (request) => {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/live" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return live.connect(request, { onMessage });
  }

  if (pathname === "/api/info") {
    return Response.json(live.info(), { headers: { "cache-control": "no-store" } });
  }

  if (pathname === "/api/config") {
    return Response.json({ allowCrash: allowCrash() });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
};

onStart(live.start);
onShutdown(live.stop);
onHealthCheck(() => ({ namedMetrics: { websockets: live.info().sockets } }));
