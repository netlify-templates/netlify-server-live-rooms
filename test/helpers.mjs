// Shared by the integration tests: instances of the server run as separate
// processes against the local database, and a bare WebSocket client that
// speaks the protocol directly.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const INSTANCE = fileURLToPath(new URL("../scripts/instance.mjs", import.meta.url));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const until = async (condition, ms = 5_000, label = "condition") => {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const value = await condition();

    if (value) {
      return value;
    }
    await sleep(20);
  }
  throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
};

const opened = { instances: new Set(), clients: new Set() };

// Closes every client and stops every instance the tests opened, so a failed
// test can't keep the test process alive.
export const cleanup = async () => {
  opened.clients.forEach((client) => client.close());
  await Promise.all([...opened.instances].map((instance) => stopInstance(instance, "SIGKILL")));
};

// Starts an instance on a port the OS picks. Resolves once it's listening.
export const startInstance = (env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INSTANCE], { env: { ...process.env, PORT: "0", DEPLOY_ID: `test-${crypto.randomUUID().slice(0, 8)}`, GRACE_MS: "3000", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";

    child.stdout.on("data", (chunk) => {
      log += chunk;

      const listening = log.match(/listening on (\d+)/);

      if (listening && !child.listening) {
        const port = Number(listening[1]);

        child.listening = true;

        const instance = { port, child, url: `ws://localhost:${port}/api/live`, log: () => log, exited: new Promise((done) => child.on("exit", (code) => done(code))) };

        opened.instances.add(instance);
        instance.exited.then(() => opened.instances.delete(instance));
        resolve(instance);
      }
    });
    child.stderr.on("data", (chunk) => (log += chunk));
    child.on("exit", (code) => reject(new Error(`instance exited with ${code} before listening:\n${log}`)));
  });

export const stopInstance = async (instance, signal = "SIGTERM") => {
  if (instance.child.exitCode === null) {
    instance.child.kill(signal);
  }

  return instance.exited;
};

// A bare protocol client. `messages` keeps everything received, and `next`
// resolves with the first message (already received or still to come) that
// matches a predicate. It's driven by the message events rather than polling,
// so the benchmark can time with it. `headers` (Node's WebSocket takes them)
// can carry a cookie or an Origin.
export const connect = (url, params, { headers } = {}) =>
  new Promise((resolve, reject) => {
    const query = new URLSearchParams({ client: crypto.randomUUID(), ...params });
    const socket = new WebSocket(`${url}?${query}`, headers ? { headers } : undefined);
    const waiters = new Set();
    const client = {
      socket,
      messages: [],
      closed: null,
      send: (message) => socket.send(JSON.stringify(message)),
      of: (type) => client.messages.filter((message) => message.type === type),
      next: (predicate, ms = 5_000) => {
        const found = client.messages.find(predicate);

        if (found) {
          return Promise.resolve(found);
        }

        return new Promise((done, fail) => {
          const waiter = { predicate, done };

          waiters.add(waiter);
          setTimeout(() => waiters.delete(waiter) && fail(new Error(`Timed out after ${ms} ms waiting for a message`)), ms).unref();
        });
      },
      close: () => socket.close(),
    };

    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);

      client.messages.push(message);
      for (const waiter of waiters) {
        if (waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.done(message);
        }
      }
    };
    socket.onopen = () => {
      opened.clients.add(client);
      resolve(client);
    };
    socket.onerror = () => reject(new Error(`couldn't connect to ${url}`));
    socket.onclose = ({ code }) => {
      client.closed = code;
      opened.clients.delete(client);
    };
  });

export const op = (kind, id, extra = {}) => ({ type: "op", id: crypto.randomUUID(), op: { kind, id, x: 1, y: 1, text: id, color: "#ffd166", ...extra } });

export const roomId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
