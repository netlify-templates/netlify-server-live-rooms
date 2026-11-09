// A local stand-in for Netlify's routing, so you can rehearse the demo
// without deploying. It runs instances of the server (scripts/instance.mjs)
// and sends new traffic to the live one:
//
// - Deploy (press d, or POST /_local/deploy): starts an instance with a new
//   deploy id and makes it live. The old one keeps its open sockets for
//   OVERLAP_MS (default 20 s, shorter than on Netlify), then gets
//   SIGTERM, which runs its onShutdown.
// - An instance that exits on its own (the Crash button) is replaced, the way
//   the platform restarts it.
//
// Needs NETLIFY_DB_URL; `npm run db:local` starts a Postgres and writes it to .env.
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8888);
const OVERLAP_MS = Number(process.env.OVERLAP_MS ?? 20_000);

if (!process.env.NETLIFY_DB_URL) {
  console.error("NETLIFY_DB_URL isn't set. Run `npm run db:local` first.");
  process.exit(1);
}

let live;
const instances = new Set();

const newDeployId = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);

const startInstance = (deployId) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./instance.mjs", import.meta.url))], {
      // The Crash button is on locally, unless ALLOW_CRASH says otherwise.
      env: { ALLOW_CRASH: "true", ...process.env, PORT: "0", DEPLOY_ID: deployId },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const instance = { port: null, deployId, child, stopping: false };

    instances.add(instance);

    createInterface({ input: child.stdout }).on("line", (line) => {
      console.log(`  [${instance.port ?? "starting"} ${deployId.slice(0, 8)}] ${line}`);

      const listening = line.match(/^listening on (\d+)/);

      if (listening) {
        instance.port = Number(listening[1]);
        resolve(instance);
      }
    });

    child.on("exit", (code) => {
      instances.delete(instance);
      console.log(`  [${instance.port}] exited (${code})`);

      if (!instance.stopping && instance === live) {
        console.log("  the live instance died; starting a replacement");
        live = undefined;
        startInstance(deployId).then(
          (replacement) => (live = replacement),
          (error) => console.error(error.message),
        );
      }
      reject(new Error(`instance exited with ${code} before listening`));
    });
  });

const deploy = async () => {
  const previous = live;
  const next = await startInstance(newDeployId());

  live = next;
  console.log(`deployed ${next.deployId.slice(0, 8)} on :${next.port}; new connections go there`);

  if (previous) {
    console.log(`  :${previous.port} keeps its sockets for ${OVERLAP_MS / 1000} s, then gets SIGTERM`);
    setTimeout(() => {
      previous.stopping = true;
      previous.child.kill("SIGTERM");
    }, OVERLAP_MS);
  }

  return next;
};

const state = () => ({
  live: live && { port: live.port, deploy: live.deployId },
  instances: [...instances].map(({ port, deployId, stopping }) => ({ port, deploy: deployId, stopping })),
});

const server = http.createServer(async (req, res) => {
  if (req.url === "/_local/deploy" && req.method === "POST") {
    const next = await deploy();

    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ port: next.port, deploy: next.deployId }));
  }
  if (req.url === "/_local/state") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
  }
  if (!live) {
    return res.writeHead(503).end("No instance is running yet");
  }

  const upstream = http.request({ port: live.port, path: req.url, method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });

  upstream.on("error", () => res.writeHead(502).end("Instance unavailable"));
  req.pipe(upstream);
});

// WebSockets: pipe the raw connection to the live instance. It stays on that
// instance until one side closes it, which is why a deploy leaves old sockets
// on the old instance.
server.on("upgrade", (req, socket, head) => {
  if (!live) {
    return socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
  }

  const upstream = net.connect(live.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];

    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

// When a test starts the harness and dies without stopping it, stop too,
// rather than hold on to the port.
const parent = process.ppid;

setInterval(() => process.ppid !== parent && process.emit("SIGINT"), 1_000).unref();

await deploy();
server.listen(PORT, () => {
  console.log(`\nLive board on http://localhost:${PORT}`);
  console.log("Press d + Enter to deploy, q + Enter to stop.\n");
});

if (process.stdin.isTTY) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "d") {
      deploy();
    } else if (line.trim() === "q") {
      process.emit("SIGINT");
    }
  });
}

process.on("SIGINT", () => {
  for (const instance of instances) {
    instance.stopping = true;
    instance.child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 1_000);
});
