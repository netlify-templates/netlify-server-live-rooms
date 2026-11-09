// Starts a local Postgres in Docker, applies the migrations in
// netlify/database/migrations, and writes NETLIFY_DB_URL to .env.
//
// `netlify dev` can also give you a local database; this exists so the local
// harness (scripts/local.mjs) can run several instances against one.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";

import pg from "pg";

const CONTAINER = "live-rooms-db";
const PORT = 54329;
const DB_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const MIGRATIONS = fileURLToPath(new URL("../netlify/database/migrations/", import.meta.url));
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

const running = docker("ps", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}");

if (!running) {
  const exists = docker("ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.Names}}");

  if (exists) {
    docker("start", CONTAINER);
  } else {
    docker("run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:5432`, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine");
  }
  console.log(`Started Postgres in the ${CONTAINER} container`);
}

let client;

for (let attempt = 0; ; attempt++) {
  try {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    break;
  } catch (error) {
    if (attempt > 30) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

await client.query("create table if not exists _local_migrations (name text primary key, applied_at timestamptz default now())");

const applied = new Set((await client.query("select name from _local_migrations")).rows.map((row) => row.name));

for (const name of readdirSync(MIGRATIONS).sort()) {
  if (!applied.has(name)) {
    await client.query("begin");
    await client.query(readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"));
    await client.query("insert into _local_migrations (name) values ($1)", [name]);
    await client.query("commit");
    console.log(`Applied ${name}`);
  }
}

await client.end();

const env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";

if (!env.includes("NETLIFY_DB_URL=")) {
  writeFileSync(ENV_FILE, `${env}${env && !env.endsWith("\n") ? "\n" : ""}NETLIFY_DB_URL=${DB_URL}\n`);
  console.log("Wrote NETLIFY_DB_URL to .env");
}

console.log(`Database ready at ${DB_URL}`);
