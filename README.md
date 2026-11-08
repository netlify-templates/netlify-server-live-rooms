# Live rooms on Netlify Server

This is a small pattern for multi-user WebSocket apps on Netlify Server, which stay consistent when instances are replaced on deploy, recycled, crash or run side by side. The demo app is a sticky-note board that several people can edit at once.

The pattern lives in two places, and neither of them knows anything about boards:

- [netlify/server/live/](netlify/server/live/index.mjs) is the server side, on Netlify Server and Netlify Database.
- [public/live/room.js](public/live/room.js) is the client side, for the browser (it runs in Node too).

The board plugs into both with a single pure function, `applyOp(state, op)`, in [public/board.js](public/board.js).

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-templates/netlify-server-live-rooms)

## The pattern

**Instances keep no state that matters. The database is the only source of truth, and an instance just relays what's in it.** In practice, that comes down to five rules:

1. The server confirms a change to the client only after it's committed to the database.
2. Every change gets its room's next version number, so each room has an ordered log of changes.
3. A client remembers the last version it saw. After any reconnect, whatever the reason, it asks for the events after that version.
4. A client keeps the changes that weren't confirmed yet (its outbox), and resends them after a reconnect. Each change has an id, and the database keeps the answer it got, so a resent change is never applied twice, and a rejected change stays rejected.
5. On shutdown, an instance only tells its clients to reconnect. There's nothing to flush.

With these in place, every failure ends the same way - the client reconnects and catches up:

| What happens | What the client sees | Why nothing is lost or repeated |
|---|---|---|
| A deploy | Its socket stays on the old instance, which keeps getting every write (including the new instance's). When the old instance shuts down, `onShutdown` closes the socket with code 1012, and the client reconnects to the new one. | Both instances read and write the same log. |
| An instance is recycled | Same as the second half of a deploy. | Same. |
| An instance crashes | The socket drops, and the client reconnects with backoff. | Everything the client had confirmed was already committed, and everything else is still in its outbox. |
| A commit fails (say the database is down) | The server closes the socket, and the client reconnects and resends. | The change stays in the outbox. Only `apply` throwing can reject a change. |
| The client goes offline | Changes pile up in the outbox and show as pending. | They're sent in order once it's back, and duplicates are ignored. |
| A NOTIFY is lost | Events arrive a bit later, on the next poll. | Instances read events from the table, so a notification is only a wake-up call. |

### Why this matters even with one instance

On a plan that runs one instance at a time, you might be tempted to keep each room in memory. However, a deploy starts a new instance while the old one keeps its open sockets until it shuts down. During that time, people in the same room are split across two instances running different code, and in-memory state would drift apart.

## Using it for your own app

You supply what a room's state looks like, and how a change applies to it. `apply(state, op)` returns the new state, or throws if the change doesn't apply (the error's message becomes the rejection reason). It runs in two places: on the server, inside the transaction that commits a change, and on the client, which applies the events it receives and shows its own pending changes on top. So it has to be:

1. **Pure and deterministic.** The server and every client must get the same state from the same events.
2. **Fine with plain JSON.** Both sides see a change as it's stored, after a round trip through JSON.
3. **Returning a state Postgres can store as `jsonb`.** That means no NUL characters, and no half of an emoji (which you get by cutting a string by UTF-16 units). Otherwise, every commit of that change fails, and its client keeps resending it.
4. **The same in every version that's running at the same time.** Clients don't receive the state after each event, they compute it. If a deploy changes what `apply` returns for the same change (say it rounds coordinates differently), the tabs that still run the old code, and the old instance during the overlap, would compute a different state from the same events, and nothing would notice. Adding a new kind of operation has the same problem: an old tab's `apply` throws on a kind it doesn't know (which makes it resync over and over), and an old instance would reject the change for good. So don't send a new kind of operation until everything that's running can handle it.

On the server:

```js
import { onShutdown, onStart } from "@netlify/server";
import { createLive } from "./live/index.mjs";
import { apply, INITIAL_STATE } from "../../public/my-app.js";

const live = createLive({ apply, initialState: INITIAL_STATE });

export const config = { path: "/api/*" };

export default (request) => live.connect(request);

onStart(live.start);
onShutdown(live.stop);
```

In the browser:

```js
import { LiveRoom } from "./live/room.js";
import { apply } from "./my-app.js";

const room = new LiveRoom({ url: "wss://<your-site>/api/live", room: "lobby", author: "Ana", apply });

room.on("change", () => render(room.view()));
room.open();
room.change({ kind: "rename", name: "New name" });
```

`room.view()` is the confirmed state, with this client's pending changes on top. `room.on()` also gives you `status`, `event` (each confirmed change, handy for an activity feed), `reject`, `presence` and `server` (which instance and deploy the client is connected to). `room.setPresence(data)` shares something small about this client, like a name, with the others in the room. [public/app.js](public/app.js) uses all of these.

`live.connect()` also takes an `onMessage(message, conn)` for messages that aren't part of the protocol. The board uses it for the demo's Crash button.

## How it works

### Committing changes

A connection's changes wait for its join to finish, then queue up per room on the instance. [relay.mjs](netlify/server/live/relay.mjs) commits each room's queue in batches, one batch at a time. That way, a connection's changes are committed in the order it sent them ("add a note" can't lose a race to "move that note"), and a busy room needs two database round trips per batch rather than per change.

`commit` in [store.mjs](netlify/server/live/store.mjs) does these two round trips:

1. Read the room's state, version and write count, and which of the batch's ids were answered before. A resent change gets the same answer as the first time: either the version it was committed at, or the reason it was rejected.
2. Run `apply` on each change in order. If it throws, that change is rejected and the rest go on. Then a single statement writes the new events, the rejections and the room's new state and version, and calls `pg_notify` - but only if the room's write count is still the one it read. If another instance wrote to the room in between, nothing is written, and the batch starts over.

Storing the rejections is what gives each change exactly one answer. Otherwise, a change that one instance rejected could still be committed by another one (or by the same one, later in a batch) once the room has changed. The check is on the write count rather than the version, because a write that only rejects changes doesn't change the version.

The same check also makes versions follow commit order. With a global sequence (`bigserial`), two inserts can commit out of order, and a reader that already saw version 105 would never see a 104 that committed after it. And since nothing is locked between the two round trips, writers don't wait on each other's network latency.

If a commit fails for any reason other than `apply` throwing (say the database restarted), the server closes the batch's connections, and their clients reconnect and resend. Queries time out after 10 s, so a database that stops answering without closing its connections can't hold a room's changes forever.

### Relaying events

For each room with clients on the instance, [relay.mjs](netlify/server/live/relay.mjs) keeps the last version it relayed (its cursor), and each connection keeps the last version it was sent. Events reach connections in one way only: the instance reads the room's events after its cursor, and sends each one to the connections that don't have it yet. Three things trigger that read:

- **A commit on this instance.**
- **A NOTIFY from another instance.** Each commit sends one with the room id, and every instance `LISTEN`s. A notification can get lost (say the listening connection drops), and through a pooler in transaction mode, `LISTEN` succeeds but notifications never arrive.
- **Polling.** Once a second, the instance compares each room's version with its cursor. This never misses anything, so a lost notification costs at most a second.

Polling only queries the database while the instance has clients, so an idle site doesn't keep the database awake.

### Connecting

The client connects with `?room=…&client=…&author=…&since=<version>`. The server sends the events after `since`, or a snapshot of the room if the client has no version yet or is more than 500 versions behind. Then it sends `ready`, and the client resends its outbox before it reports that it's live. The full protocol is described at the top of [live/index.mjs](netlify/server/live/index.mjs).

Close code 1012 (from `onShutdown`) makes clients reconnect within a random 0-1 s. Any other close backs off exponentially with jitter, up to 10 s, and the backoff starts over once a connection gets to `ready`. The client also pings every 10 s, and drops a connection it hasn't heard from in 20 s, since a browser can keep a dead connection open for minutes after a network change.

The server protects itself from what clients send:

- A message over 64 KB closes the connection.
- Anything that throws while a message is handled closes only that connection. The handler runs inside the socket's data callback, where an exception would take the whole instance down.
- A change goes through JSON before `apply` sees it, so the server applies exactly what it stores and relays. (`1e400` parses as Infinity, which JSON stores as `null`.)
- A change with a malformed id, or with text Postgres can't store, is rejected up front, since it could never be committed.
- A client that falls more than 1 MB behind on reading is dropped, and resumes when it reconnects.

### Presence

[presence.mjs](netlify/server/live/presence.mjs) keeps track of who's in each room. That's soft state, so it stays out of the log. Every 300 ms, each instance writes (in one statement) the rows of its clients whose data changed or that it hasn't written in 3 s. Then it reads its rooms' rows that were seen in the last 8 s, and sends each room's list to its clients if it changed.

A client that joins gets the room's current list right away. Presence data that Postgres can't store is ignored, since it would fail the write for everyone on the instance. When an instance stops, it deletes its rows. When it crashes, its clients disappear once their rows are 8 s old.

### What it doesn't do

1. **There's no authentication.** Anyone who can reach the site can join any room, under any name.
2. **The log and the rejections are never trimmed.** A client more than 500 versions behind gets a snapshot anyway, so old events aren't needed to rebuild a room. However, their ids are what makes a late resend safe: if a client was offline for a long time with a change that was committed but never confirmed, and that id is gone, the change would be applied again. Trimming safely means keeping the ids (or limiting how long a client may hold on to a change), rather than just deleting old rows.
3. **A room's state is one `jsonb` value,** written with every batch. That's fine for something the size of a board. For large state (a big canvas, a long document), you'd keep the state in Netlify Blobs as a snapshot every N events, with a pointer to it in the database.
4. **Each instance commits a room's batches one at a time.** If several instances write to the same busy room at once (with a single instance, that only happens during a deploy's overlap), their commits collide and retry.
5. **There's no rate limiting, and a change is stored as the client sent it,** extra fields included, up to the 64 KB message limit. An app with untrusted clients would want both a per-connection limit, and an `apply` that returns the normalized change to store.
6. **Different versions of `apply` aren't detected** (see "Using it for your own app" above).
7. **The outbox lives in memory.** Unsent changes survive reconnects, deploys and crashes, but not a reload or a closed tab.

## Running it locally

You need Node 24 and Docker.

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run local
```

`db:local` starts Postgres in a container, applies the migration from `netlify/database/migrations`, and writes `NETLIFY_DB_URL` to `.env`. To start over with an empty database, remove the container (`docker rm -f live-rooms-db`) and run it again.

`local` runs [scripts/local.mjs](scripts/local.mjs) on http://localhost:8888. It stands in for Netlify's routing, and runs each instance as a separate process through [scripts/instance.mjs](scripts/instance.mjs), which runs the lifecycle hooks and WebSocket upgrades the way Netlify Server does:

- Press `d` + Enter (or `POST /_local/deploy`) to deploy. A new instance with a new deploy id becomes live, and the old one keeps its sockets for `OVERLAP_MS` (20 s by default) before it gets a SIGTERM.
- An instance that exits by itself (say from the Crash button) is replaced, the way the platform would restart it. The Crash button is on locally (`ALLOW_CRASH=true` by default).
- `NOTIFY=off` turns NOTIFY off, so instances only poll.

## Testing

There are four layers, from fast and narrow to slow and broad. Everything except the unit tests needs the local database (`npm run db:local`).

| Layer | Command | What it covers |
|---|---|---|
| Unit | `npm test` ([board](test/board.test.mjs), [room](test/room.test.mjs)) | The board's rules, and the rules of `LiveRoom` against a fake WebSocket with mocked timers: pending changes, acks before and after events, rejections, resuming with `since`, resending the outbox in order, backoff, the heartbeat, resyncing on a gap, late events from an old socket, and going offline. |
| Integration | `npm test` ([store](test/store.test.mjs), [relay](test/relay.test.mjs), [server](test/server.test.mjs)) | The commit against Postgres: order within a batch, concurrent commits (no gaps, and the log replays to the stored state), duplicates, rejections that stay rejected, writers racing on the same change, and errors that can be retried. The relay's write path with a misbehaving `apply`. The server over real WebSockets, with instances as separate processes, both with NOTIFY (proving NOTIFY is what delivered) and with polling only: relaying between instances, joining with and without `since`, bad parameters, changes sent before `ready`, per-connection order, duplicates from two connections, a client joining while the last one leaves, hostile input, presence, graceful shutdown and a crash. |
| Scenarios | `npm run test:failover`, `npm run test:chaos -- [seconds] [seed]` | The whole system through the local harness, with clients writing the whole time. `test:failover` runs one fixed scenario: a deploy and its overlap, the old instance's shutdown, a crash with one client offline, a database restart, and a database that stops answering. `test:chaos` runs a seeded random mix of deploys, crashes, database restarts, and clients going offline, leaving and joining, across three rooms. |
| A deploy | `npm run test:remote -- <url>` | The same checks against a real deploy on Netlify, through a real `netlify deploy --prod` and a crash. |

The scenario and deploy tests use the real `LiveRoom`, wrapped in [scripts/lib/client.mjs](scripts/lib/client.mjs) to make random changes and record what happens. At the end, they check that:

1. Every outbox is empty.
2. Every client has the same state as the database, at the same version.
3. Every change was committed exactly once, or rejected.
4. Each client's changes were committed in the order it made them.
5. Every client applied every version once, in order.
6. The event log has no gaps.

Note: `test:remote` needs the deploy to change the server's code. If the bundle is the same as before, the platform keeps the running instance (and comments don't count, since the bundler drops them). The test stops early and tells you when that happens. It also needs `ALLOW_CRASH=true` on the site, and says so if it isn't set.

## Performance

`npm run bench` measures locally, with two instances against the Docker database, and `npm run bench -- <url>` measures a deploy. Every change in the benchmark is a "move" of the same note, so nothing gets rejected, and the numbers are about the plumbing rather than the board's rules. Latencies are measured by the benchmark's client, from sending a change to receiving its ack or its event, so on a deploy they include the network both ways.

Locally, the database runs in Docker, whose networking adds latency after a pause (so the first query after idling is slower). Compare the local numbers with each other, rather than with a deploy.

## Deploying

```bash
netlify sites:create --name <your-site-name> --account-slug <a-team-with-netlify-server>
```

```bash
netlify deploy --prod
```

The migration in `netlify/database/migrations` is applied on deploy, and Netlify Database sets `NETLIFY_DB_URL` for the server. Netlify serves the page from `public/`, and the server handles `/api/*`.

A few things about [Netlify Server](https://docs.netlify.com/build/server/) and [Netlify Database](https://docs.netlify.com/build/data-and-storage/netlify-database/) that this relies on:

- WebSockets aren't cut off by the response timeout, and an instance with open sockets doesn't stop for inactivity. A WebSocket is closed when it reaches the [request duration limit](https://docs.netlify.com/build/server/limits/#request-duration), and the client reconnects like after any other close.
- The deploy id comes from `getContext().deploy.id`, which only works while handling a request.
- A migration can't be changed once it's applied, so any schema change needs a new migration.
- The server runs in the default region unless you set `config.region`.

The Crash button is off unless you set `ALLOW_CRASH=true`, since it works for anyone who can open the board. While it's off, the button shows as disabled, with a tooltip that explains what it does and how to turn it on. Turn it on for your own deploy, not on a site that strangers can reach.

## The demo

The board's top bar links to a How it works page ([public/how-it-works.html](public/how-it-works.html)), which walks through the mechanism with diagrams and links to the relevant Netlify docs.

1. Open the board in two browsers (or a normal window and a private one). The header shows the instance and deploy each one is connected to, and the people list shows everyone's instance.
2. Deploy a change to the server's code, and open a third tab, which lands on the new instance. Edit from there. The first two tabs, which are still on the old instance, see the edits, and the activity list shows which instance committed each one.
3. Wait for the old instance to shut down (it can take a few minutes). The first two tabs move to the new deploy at the same version, with nothing duplicated or missing.
4. Press **Crash instance** (on a site with `ALLOW_CRASH=true`). The process exits without running `onShutdown`. The tabs reconnect once the platform starts a new instance, and nothing that was confirmed is lost.
5. Press **Go offline**, add and move a few notes (they show faded, with an "unsent" count), then go back online. They're sent once and confirmed.
6. Add a few simulated users from the side panel. Each one is a `LiveRoom` with its own socket, so to the server it's just another person: it shows up in "Here now" with its instance, and reconnects and resends after a deploy or a crash like any other client.
   - **Tidy** lines the notes up in rows, and puts back any note you drag away.
   - **Writer** types into notes a few words at a time.
   - **Flaky wifi** writes like Writer, but goes offline every few seconds. Its unsent count grows while it's offline, and some of those changes are rejected when it's back, because someone deleted the note in the meantime.
   - **Gremlin** deletes notes (down to three) and flings the rest around.

   Each one's row shows its unsent, committed and rejected changes, and the speed buttons change how often they act (Frantic is about ten changes a second each). A note someone else changes lights up in their color for a moment. Simulated users pause while their tab is hidden, and leave after 10 minutes.

## Files

```
netlify/server/live/index.mjs     createLive(): the protocol, connections and lifecycle
netlify/server/live/store.mjs     all the SQL, including the batched commit
netlify/server/live/relay.mjs     this instance's rooms: joining, committing, relaying, NOTIFY and polling
netlify/server/live/presence.mjs  who's in each room
netlify/server/live/every.mjs     the background loop helper
netlify/server/index.mjs          the board's server: createLive() wired to Netlify Server
netlify/database/migrations/      the schema
public/live/room.js               LiveRoom: confirmed state, outbox, resume, reconnect, heartbeat
public/board.js                   the board's rules: applyOp and its state
public/app.js                     the board's page
public/how-it-works.html          the How it works page, linked from the board's top bar
public/bots.js                    the demo's simulated users
test/                             unit and integration tests (npm test)
scripts/local.mjs                 local routing, deploys and crash restarts
scripts/instance.mjs              one local instance, run the way Netlify Server runs it
scripts/local-db.mjs              local Postgres and the migration
scripts/test-failover.mjs         one fixed failure scenario, with the local harness
scripts/test-chaos.mjs            seeded random failures across rooms, with the local harness
scripts/test-remote.mjs           the failure scenario against a deploy
scripts/bench.mjs                 the performance numbers
scripts/lib/client.mjs            the test client, the harness and the shared checks
```
