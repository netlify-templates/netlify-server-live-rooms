# Live rooms on Netlify Server

This repo shows how to build a multi-user, real-time app with WebSockets on Netlify Server. The tricky part is keeping everyone in sync while server instances come and go (on every deploy, when they're recycled, or when one crashes). The demo app is a sticky-note board that several people can edit at once.

There are two parts to this repo:

1. The code that keeps everyone in sync, which you can reuse in any app. The server side is in [netlify/server/live/](netlify/server/live/index.mjs) (on Netlify Server, with Netlify Database), and the client side is in [public/live/room.js](public/live/room.js) (for the browser, and it runs in Node too).
2. The sticky-note board, which is the demo. It plugs into the first part with one function, `applyOp(state, op)`, in [public/board.js](public/board.js).

You can see it live at [netlify-server-live-rooms-example.netlify.app](https://netlify-server-live-rooms-example.netlify.app/), or deploy your own copy:

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-templates/netlify-server-live-rooms)

## The idea

**All the data that matters lives in the database. Server instances only read from it and pass changes along to their clients, so any instance can go away at any time without losing anything.** In practice, it comes down to five rules:

1. The server tells a client its change went through only after the change is committed to the database.
2. Every change gets the room's next version number, so each room has an ordered log of changes.
3. A client remembers the last version it saw. After any reconnect, for whatever reason, it asks for the changes after that version.
4. A client keeps the changes that weren't confirmed yet (its outbox), and sends them again after a reconnect. Each change has an id, and the database remembers what happened to it, so a change sent twice is applied only once, and a rejected change stays rejected.
5. When an instance shuts down, all it does is tell its clients to reconnect. There's nothing to save first.

With these rules, every kind of failure ends the same way: the client reconnects and catches up.

| What happens | What the client sees | Why nothing is lost or applied twice |
|---|---|---|
| A deploy | Its socket stays on the old instance, which keeps getting every write (including the ones made on the new instance). When the old instance shuts down, `onShutdown` closes the socket with code 1012, and the client reconnects to the new one. | Both instances read and write the same log. |
| An instance is recycled | The same as the end of a deploy: the socket is closed with 1012, and the client reconnects. | Same as a deploy. |
| An instance crashes | The socket drops, and the client reconnects, waiting a bit longer after each failed attempt. | Everything the client got a confirmation for was already committed, and everything else is still in its outbox. |
| A commit fails (say the database is down) | The server closes the socket, and the client reconnects and sends its changes again. | The change stays in the outbox. A failed commit never rejects a change. |
| The client goes offline | Its changes wait in the outbox and show as unsent. | They're sent in order once it's back, and any duplicates are ignored. |
| A NOTIFY gets lost | Changes from other instances show up a bit later, on the next poll. | Instances always read changes from the table. A notification only tells them there's something new to read. |

### Why this matters even with one instance

If your plan runs one instance at a time, you might be tempted to keep each room in memory. However, a deploy starts a new instance while the old one keeps its open sockets until it shuts down. Meanwhile, people in the same room are split between two instances running different code, and anything kept in memory would drift apart.

## Using it in your own app

You decide what a room's state looks like, and how a change applies to it. `apply(state, op)` returns the new state, or throws if the change doesn't apply (the error message becomes the reason the change was rejected).

`apply` runs on both sides. The server runs it when it commits a change (between reading the room and writing to it, and again if the commit has to start over). The client runs it on every change it receives, and to show its own unsent changes on top. So it needs to be:

1. Pure and deterministic. The server and every client must get the same state from the same changes.
2. Fine with plain JSON. Both sides see a change the way it's stored, after a round trip through JSON.
3. Returning a state Postgres can store as `jsonb`. That means no NUL characters, and no half of an emoji (which is what you get when you cut a string by UTF-16 units). Otherwise, every commit of that change fails, and its client keeps sending it again.
4. The same in every version of your code that's running at the same time.

Note: clients don't get the room's state after each change, they work it out themselves. If a deploy changes what `apply` returns for the same change (say it rounds coordinates differently), tabs that still run the old code, and the old instance until it shuts down, would end up with a different state from the same changes, and nothing would notice. Adding a new kind of change has the same problem: an old tab's `apply` throws on a kind it doesn't know (so it keeps reloading the room), and an old instance would reject the change for good. So don't send a new kind of change until everything that's running can handle it.

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

const room = new LiveRoom({ url: "wss://<your-site>/api/live", room: "lobby", apply });

room.on("change", () => render(room.view()));
room.open();
room.change({ kind: "rename", name: "New name" });
```

`room.view()` gives you the confirmed state with this client's unsent changes on top. With `room.on()` you can also listen to:

- `status`: connecting, live, reconnecting or offline.
- `event`: each confirmed change (handy for an activity feed).
- `reject`: a change that was rejected, and why.
- `presence`: who else is in the room.
- `server`: which instance and deploy the client is connected to, the client's name, and whether it's read-only.

`room.setPresence(data)` shares something small about this client with the others in the room, like a color or a cursor position. [public/app.js](public/app.js) uses all of these.

The server picks everyone's name, so people can't put whatever name they want on a public board. It turns each client's id into a name with the `nameOf(client)` function you pass to `createLive()` (by default, the start of the id). The client gets its name in the `hello` message, and everyone else sees it on the client's changes and in presence. The board's [names.mjs](netlify/server/names.mjs) makes names like "Sunny Otter".

`live.connect()` also takes two options:

- `readOnly`: the connection gets everything, but its changes are rejected, and opening a room that doesn't exist doesn't create it. The board uses this for [`EDIT_TOKEN`](#making-a-site-read-only).
- `onMessage(message, conn)`: gets any message that isn't part of the protocol. The board uses it for the demo's Crash button.

## How it works

This part is for anyone curious about what happens under the hood.

### Committing changes

A connection's changes wait until it has finished joining the room, and then go into a queue for that room on the instance. [relay.mjs](netlify/server/live/relay.mjs) commits each room's queue in batches, one batch at a time. That way, a connection's changes are committed in the order it sent them (so "add a note" can't lose a race to "move that note"), and a busy room needs two database round trips per batch, rather than per change.

`commit` in [store.mjs](netlify/server/live/store.mjs) does these two round trips:

1. Read the room's state, version and write count, and check whether any of the batch's ids were handled before. A change that's sent again gets the same result as the first time: either the version it was committed at, or the reason it was rejected.
2. Run `apply` on each change in order. If it throws, that change is rejected and the rest carry on. Then one SQL statement writes the new changes, the rejections and the room's new state and version, and calls `pg_notify` - but only if the room's write count is still the one it read. If another instance wrote to the room in between, nothing is written, and the batch starts over.

The rejections are stored too, so a change can't be rejected by one instance and then committed by another (or by the same one, later in a batch) once the room has changed. The check uses the write count rather than the version, because a write that only rejects changes doesn't bump the version.

The same check also makes versions follow the order of commits. With a global sequence (`bigserial`), two inserts can commit out of order, and a reader that already saw version 105 would never see a 104 that committed after it. And since nothing is locked between the two round trips, writers don't wait on each other's network latency.

If a commit fails for any reason other than `apply` throwing (say the database restarted), the server closes the batch's connections, and their clients reconnect and send their changes again. Queries time out after 10 s, so a database that stops answering without closing its connections can't hold up a room's changes forever.

### Sending changes to clients

For each room with clients on the instance, [relay.mjs](netlify/server/live/relay.mjs) keeps the last version it sent out, and each connection keeps the last version it got. Changes always reach clients the same way. The instance reads the room's changes after the last one it sent out, and sends each one to the connections that don't have it yet. Three things make it read:

- A commit on the same instance.
- A NOTIFY from another instance. Each commit sends one with the room's id, and every instance listens for them. A notification can get lost (say, if the listening connection drops). Also, through a connection pooler in transaction mode, `LISTEN` works but notifications never arrive.
- Polling. Once a second, the instance compares each room's version with the last version it sent out. Polling never misses anything, so a lost notification delays changes by a second at most.

Polling only queries the database while the instance has clients, so a site nobody's using doesn't keep the database awake.

### Connecting

The client connects with `?room=…&client=…&since=<version>`. The server sends the changes after `since`, or a snapshot of the whole room if the client has no version yet or is more than 500 versions behind. Then it sends `ready`, and the client sends its outbox again before it shows itself as live. The full protocol is described at the top of [live/index.mjs](netlify/server/live/index.mjs).

After close code 1012 (from `onShutdown`), clients reconnect within a random 0-1 s. After any other close, they wait longer after each failed attempt (with some randomness, up to 10 s), and go back to a short wait once a connection gets to `ready`. The client also pings every 10 s, and drops a connection it hasn't heard from in 20-30 s, because a browser can keep a dead connection open for minutes after a network change.

The server protects itself from what clients send:

- A message over 64 KB closes the connection.
- If handling a message throws, only that connection is closed. The handler runs inside the socket's data callback, where an exception would take the whole instance down.
- A change goes through JSON before `apply` sees it, so the server applies exactly what it stores and sends to others. (For example, `1e400` parses as Infinity, which JSON stores as `null`.)
- A change with a malformed id, or with text Postgres can't store, is rejected right away, since it could never be committed.
- A client that falls more than 1 MB behind on reading is dropped, and catches up when it reconnects.

### Presence

[presence.mjs](netlify/server/live/presence.mjs) keeps track of who's in each room. It's fine to lose this on a crash, so it stays out of the log. Every 300 ms, each instance writes (in one statement) the rows of its clients whose data changed, or that it hasn't written in 3 s. Then it reads the rows of its rooms that were updated in the last 8 s, and sends each room's list to its clients if it changed.

Each person in the list has the name the server gave them, along with whatever data their client shared. A client that joins gets the room's current list right away. Presence data that Postgres can't store is ignored, since it would fail the write for everyone on the instance. When an instance stops, it deletes its rows. When it crashes, its clients disappear from the list once their rows are 8 s old.

### What it doesn't do

1. There are no user accounts. Anyone who can reach the site can watch any room that exists. You can make a site read-only for everyone who doesn't have a shared token ([see below](#making-a-site-read-only)), but everyone who has it can do the same things.
2. Old changes are trimmed, but never deleted. A client more than 500 versions behind gets a snapshot anyway, so old changes aren't needed to rebuild a room. Every 10 minutes, an instance with clients removes the contents of changes older than a day (except each room's last 1,000). It keeps the rows and their ids, so a very late resend still isn't applied twice. Meanwhile, the log grows by a small row per change (and rejections are kept as they are).
3. A room's state is a single `jsonb` value, written with every batch. That's fine for something the size of a board. For a large state (a big canvas, a long document), you'd keep the state in Netlify Blobs as a snapshot every N changes, with a pointer to it in the database.
4. Each instance commits a room's batches one at a time. If several instances write to the same busy room at once (with one instance, that only happens while a deploy's old and new instances overlap), their commits collide and retry.
5. There's no rate limiting, and a change is stored the way the client sent it, extra fields included, up to the 64 KB message limit. If you can't trust your clients, you'd want both a limit per connection, and an `apply` that returns a cleaned-up change to store.
6. Different versions of `apply` running at once aren't detected (see [Using it in your own app](#using-it-in-your-own-app) above).
7. The outbox lives in memory. Unsent changes survive reconnects, deploys and crashes, but not a page reload or a closed tab.

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

`db:local` starts Postgres in a container, applies the migrations from `netlify/database/migrations` (and any new ones when you run it again), and writes `NETLIFY_DB_URL` to `.env`. To start over with an empty database, remove the container (`docker rm -f live-rooms-db`) and run it again.

`local` runs [scripts/local.mjs](scripts/local.mjs) on http://localhost:8888. It stands in for Netlify's routing, and runs each instance as a separate process with [scripts/instance.mjs](scripts/instance.mjs), which handles the lifecycle hooks and WebSocket upgrades the way Netlify Server does:

- Press `d` and then Enter (or send `POST /_local/deploy`) to deploy. A new instance with a new deploy id goes live, and the old one keeps its sockets for `OVERLAP_MS` (20 s by default) before it gets a SIGTERM.
- An instance that exits on its own (say, from the Crash button) is replaced, the way the platform would restart it. The Crash button is on locally (`ALLOW_CRASH=true` by default).
- `NOTIFY=off` turns NOTIFY off, so instances only poll.
- `EDIT_TOKEN` and `DEMO_BOTS` work locally too (see [Making a site read-only](#making-a-site-read-only)).

## Testing

There are four kinds of tests, from fast and narrow to slow and broad. All of them except the unit tests need the local database (`npm run db:local`).

| Kind | Command | What it covers |
|---|---|---|
| Unit | `npm test` ([board](test/board.test.mjs), [room](test/room.test.mjs), [bots](test/bots.test.mjs)) | The board's rules, the simulated users, and `LiveRoom` against a fake WebSocket. |
| Integration | `npm test` ([store](test/store.test.mjs), [relay](test/relay.test.mjs), [server](test/server.test.mjs)) | The commit against Postgres, and the server over real WebSockets, with each instance in its own process. |
| Scenarios | `npm run test:failover`, `npm run test:chaos -- [seconds] [seed]` | The whole thing through the local setup, with clients making changes the whole time. |
| A deploy | `npm run test:remote -- <url>` | The same checks against a real site on Netlify, with a real `netlify deploy --prod` and a crash. |

In more detail:

- The `LiveRoom` unit tests use fake timers, and cover unsent changes, confirmations that arrive before or after the change itself, rejections, catching up with `since`, sending the outbox again in order, waiting between reconnects, the pings, reloading the room after a gap, late messages from an old socket, and going offline.
- The commit tests cover the order within a batch, commits at the same time (no gaps, and replaying the log gives the stored state), duplicates, rejections that stay rejected, writers racing on the same change, and errors that can be retried. Leases and trimming old changes are tested against Postgres too, and the relay is tested with an `apply` that misbehaves.
- The server tests run once with NOTIFY (checking that NOTIFY is what delivered the changes) and once with polling only. They cover changes between instances, joining with and without `since`, bad parameters, changes sent before `ready`, the order of each connection's changes, duplicates from two connections, a client joining while the last one leaves, hostile input, presence, a graceful shutdown and a crash. With `EDIT_TOKEN`, they cover read-only connections, unlocking, and the cookie sent from another site. With `DEMO_BOTS`, they check that one instance runs the simulated users while someone watches, and that none do once nobody does.
- `test:failover` runs one fixed scenario: a deploy and its overlap, the old instance shutting down, a crash while one client is offline, a database restart, and a database that stops answering.
- `test:chaos` runs a random mix (from a seed you can repeat) of deploys, crashes, database restarts, and clients going offline, leaving and joining, across three rooms.

The scenario and deploy tests use the real `LiveRoom`, wrapped in [scripts/lib/client.mjs](scripts/lib/client.mjs) to make random changes and record what happens. At the end, the scenario tests check that:

1. Every outbox is empty.
2. Every client has the same state as the database, at the same version.
3. Every change was either committed exactly once, or rejected.
4. Each client's changes were committed in the order it made them.
5. Every client applied every version once, in order.
6. The log has no gaps.

`test:remote` can't reach the database. Instead, it treats the changes seen by a client that joined before anyone wrote as the record of what was committed, and checks the other clients against that. That's also why it can't check the log for gaps.

Note: `test:remote` only works if the deploy changes the server's code. If the bundle is the same as before, the platform keeps the running instance (and changing a comment isn't enough, since the bundler removes comments). The test stops early and tells you when that happens. It also needs `ALLOW_CRASH=true` on the site, and tells you if it isn't set.

## Performance

`npm run bench` measures locally, with two instances and the database in Docker. `npm run bench -- <url>` measures a deployed site. Every change in the benchmark moves the same note, so nothing gets rejected, and the numbers show the overhead of the setup itself rather than the board's rules. The benchmark's client measures the time from sending a change to getting its confirmation or seeing the change come back, so on a deployed site the numbers include the network both ways.

Locally, the database runs in Docker, whose networking adds latency after a pause (so the first query after a quiet moment is slower). Compare the local numbers with each other, rather than with a deployed site.

## Deploying

```bash
netlify sites:create --name <your-site-name> --account-slug <a-team-with-netlify-server>
```

```bash
netlify deploy --prod
```

The migrations in `netlify/database/migrations` are applied on deploy, and Netlify Database sets `NETLIFY_DB_URL` for the server. Netlify serves the page from `public/`, and the server handles `/api/*`.

This relies on a few things about [Netlify Server](https://docs.netlify.com/build/server/) and [Netlify Database](https://docs.netlify.com/build/data-and-storage/netlify-database/):

- WebSockets aren't cut off by the response timeout, and an instance with open sockets doesn't stop for being idle. A WebSocket is closed when it reaches the [request duration limit](https://docs.netlify.com/build/server/limits/#request-duration), and the client reconnects just like after any other close.
- `onShutdown` runs as soon as an instance starts shutting down, and gets `drained`, which resolves once the instance's work in progress is done. `live.stop` closes the sockets right away, and closes the database pool after `drained`.
- The deploy id comes from `getContext().deploy.id`, which only works while handling a request.
- A migration can't be changed once it's applied, so any change to the schema needs a new migration.
- The server runs in the default region unless you set `config.region`.

The Crash button is off unless you set `ALLOW_CRASH=true`, since anyone who can open the board could press it. While it's off, the button shows as disabled, with a tooltip that explains what it does and how to turn it on. Turn it on for your own deploy, not on a site that strangers can reach.

### Making a site read-only

By default, anyone who can open the board can edit it. If you want to share a board that people can watch but not change (like the live demo), set `EDIT_TOKEN` on the site to a long random value (say, from `openssl rand -base64 32`) and redeploy.

- Everyone can still watch, but the server makes their connections read-only ([editors.mjs](netlify/server/editors.mjs)). It rejects their changes and their Crash messages, and doesn't create the rooms they open. The page hides the editing controls, and shows a Deploy to Netlify button instead.
- To edit, open "Have the edit token?" in the side panel and paste the token. The page sends it in the body of a POST request (never in a URL), and gets back an `HttpOnly`, `SameSite=Strict` cookie. The cookie holds an HMAC of the token, not the token itself. The server only accepts the cookie on requests from the site's own pages, so another site can't use it through a visitor's browser.
- To lock every browser again, change `EDIT_TOKEN` and redeploy.

A board nobody can edit looks a bit empty, so `DEMO_BOTS` runs simulated users on the server, at the calm pace. Set it to a comma-separated list of the kinds you want (say, `DEMO_BOTS=writer,writer,mover`, up to three), and set `DEMO_BOTS_ROOM` to their room if it isn't `demo`.

They only run while someone is watching that room, and only on one instance at a time ([demo-bots.mjs](netlify/server/demo-bots.mjs)). Every 5 s, an instance with viewers in the room takes or renews a lease in the database, and runs the simulated users while it holds it. They run where the viewers are because Netlify keeps an instance running while it has open connections, but not for work the server does on its own. Each simulated user is a `LiveRoom` connected to its instance from inside the same process (`live.loopback()`), so its changes go through the same protocol and commits as everyone else's.

## The demo

The live demo is read-only, with two Writers and a Mover running on the server (see [Making a site read-only](#making-a-site-read-only)). To try everything below, deploy your own copy.

For a visual walkthrough, see the How it works page ([public/how-it-works.html](public/how-it-works.html), linked from the board's top bar), which also links to the relevant Netlify docs.

1. Open the board in two browsers (or a normal window and a private one). The header shows the instance and deploy each one is connected to, and the people list shows everyone's instance.
2. Deploy a change to the server's code, and open a third tab, which connects to the new instance. Make some edits there. The first two tabs, which are still on the old instance, see the edits, and the activity list shows which instance committed each one.
3. Wait for the old instance to shut down (it can take a few minutes). The first two tabs move to the new deploy at the same version, with nothing missing or applied twice.
4. Press **Crash instance** (on a site with `ALLOW_CRASH=true`). The process exits without running `onShutdown`. The tabs reconnect once the platform starts a new instance, and nothing that was confirmed is lost.
5. Press **Go offline**, add and move a few notes (they show faded, with an "unsent" count), then go back online. They're sent once and confirmed.
6. Add a few simulated users from the side panel. Each one is a `LiveRoom` with its own socket, so to the server it's just another person. It shows up in "Here now" with its instance, and reconnects and sends its changes again after a deploy or a crash, like any other client.
   - Tidy lines the notes up in rows, and puts back any note you drag away.
   - Writer types into notes a few words at a time.
   - Flaky wifi writes like Writer, but goes offline every few seconds. Its unsent count grows while it's offline, and some of those changes are rejected when it's back, because someone deleted the note in the meantime.
   - Mover moves notes a short way, and now and then next to another note, so the board keeps changing shape without ending up in rows.
   - Gremlin deletes notes (down to three) and flings the rest around.

   Each one's row shows its unsent, committed and rejected changes, and the speed buttons change how often they act. A note someone else changes lights up in their color for a moment. A tab can have up to three simulated users at a time. They pause while their tab is hidden, and leave after 3 minutes. One that left stays in the list until you remove it, so a tab you forgot about can't keep them busy.

## Files

```
netlify/server/live/index.mjs     createLive(): the protocol, connections and lifecycle
netlify/server/live/store.mjs     all the SQL, including the batched commit
netlify/server/live/relay.mjs     this instance's rooms: joining, committing, sending changes, NOTIFY and polling
netlify/server/live/presence.mjs  who's in each room
netlify/server/live/every.mjs     a helper for background loops
netlify/server/index.mjs          the board's server: createLive() wired to Netlify Server
netlify/server/names.mjs          the names the server gives clients
netlify/server/editors.mjs        EDIT_TOKEN: who can edit
netlify/server/demo-bots.mjs      DEMO_BOTS: simulated users on the server
netlify/database/migrations/      the database schema
public/live/room.js               LiveRoom: the confirmed state, the outbox, catching up, reconnecting and pings
public/board.js                   the board's rules: applyOp and the board's state
public/app.js                     the board's page
public/how-it-works.html          the How it works page, linked from the board's top bar
public/bots.js                    the demo's simulated users
test/                             unit and integration tests (npm test)
scripts/local.mjs                 local routing, deploys and restarts after a crash
scripts/instance.mjs              one local instance, run the way Netlify Server runs it
scripts/local-db.mjs              local Postgres and the migrations
scripts/test-failover.mjs         one fixed failure scenario, with the local setup
scripts/test-chaos.mjs            random failures across rooms, with the local setup
scripts/test-remote.mjs           the failure scenario against a deployed site
scripts/bench.mjs                 the performance numbers
scripts/lib/client.mjs            the test client, starting the local setup, and the checks the scenarios share
```
