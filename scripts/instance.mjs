// Runs one instance of the server roughly the way Netlify Server does, so you
// can run several against one database locally:
// - the start hooks run before it listens;
// - static files come from public/, and everything under /api/ goes to the
//   entry's handler;
// - WebSocket upgrades go through the same request primitives that
//   upgradeWebSocket() reads;
// - SIGTERM stops new traffic and runs the shutdown hooks right away, all at
//   once, with `drained`, within a grace period.
//
// It's a stand-in for local testing, not the platform: routing, scaling and
// recycling are the router's job (scripts/local.mjs).
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const PRIMITIVES = Symbol.for("$netlify.requestNodePrimitives");
const UPGRADED = Symbol.for("$netlify.responseUpgraded");
const LIFECYCLE = Symbol.for("@netlify/server/lifecycle");

const PORT = Number(process.env.PORT ?? 9001);
const GRACE_MS = Number(process.env.GRACE_MS ?? 10_000);
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const { default: handler } = await import("../netlify/server/index.mjs");
const lifecycle = globalThis[LIFECYCLE];

for (const hook of lifecycle.start) {
  await hook();
}
lifecycle.started = true;

const toRequest = (req, primitives) => {
  const headers = new Headers();

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  request[PRIMITIVES] = primitives;

  return request;
};

// Like Netlify, /how-it-works serves how-it-works.html.
const serveStatic = async (pathname, res) => {
  const path = pathname.endsWith("/") ? `${pathname}index.html` : extname(pathname) ? pathname : `${pathname}.html`;
  const file = normalize(join(PUBLIC, path));

  try {
    if (!file.startsWith(PUBLIC)) {
      throw new Error("outside public/");
    }
    const body = await readFile(file);

    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (!pathname.startsWith("/api/")) {
    return serveStatic(pathname, res);
  }

  try {
    const response = await handler(toRequest(req, { request: req, socket: req.socket, head: Buffer.alloc(0) }));

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    res.writeHead(500).end("Internal error");
  }
});

server.on("upgrade", async (req, socket, head) => {
  try {
    const response = await handler(toRequest(req, { request: req, socket, head }));

    if (!response[UPGRADED]) {
      socket.end(`HTTP/1.1 ${response.status} ${response.statusText}\r\nconnection: close\r\n\r\n`);
    }
  } catch (error) {
    console.error(error);
    socket.destroy();
  }
});

// If whatever started this instance (the harness, a test) dies without
// stopping it, stop too, rather than linger and hold on to a port.
const parent = process.ppid;

setInterval(() => process.ppid !== parent && process.exit(0), 1_000).unref();

// PORT=0 lets the OS pick a free port; the line below says which one.
server.listen(PORT, () => console.log(`listening on ${server.address().port}`));

let stopping = false;

process.on("SIGTERM", async () => {
  if (stopping) {
    return;
  }
  stopping = true;

  // Resolves once every open request and WebSocket is done.
  const drained = new Promise((resolve) => server.close(() => resolve()));

  server.closeIdleConnections();

  const timeout = new Promise((resolve) => setTimeout(() => resolve("timed out"), GRACE_MS));
  const hooks = Promise.all(
    lifecycle.shutdown.map(async (hook) => {
      try {
        await hook({ drained });
      } catch (error) {
        console.error("shutdown hook failed:", error);
      }
    }),
  );

  if ((await Promise.race([hooks, timeout])) === "timed out") {
    console.log("shutdown grace period ran out");
  }
  process.exit(0);
});
