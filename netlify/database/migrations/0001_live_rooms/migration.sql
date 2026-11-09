-- The tables behind netlify/server/live. Nothing here is specific to the
-- board: a room's state is whatever the app's apply() function builds.

-- One row per room: its current state and version. `writes` counts every
-- write to the room, including one that only rejects changes (which doesn't
-- change the version). A writer only writes if `writes` hasn't moved since it
-- read the room, so a room's writes happen one after another.
create table rooms (
  id text primary key,
  version bigint not null default 0,
  writes bigint not null default 0,
  state jsonb not null
);

-- Every committed change, in order. A client that reconnects asks for the
-- events after the last version it saw.
create table room_events (
  room_id text not null references rooms (id) on delete cascade,
  seq bigint not null,
  client_msg_id uuid not null,
  author text not null,
  instance_id text not null,
  op jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room_id, seq),
  unique (room_id, client_msg_id)
);

-- Every rejected change. With room_events, this gives a change one answer
-- however often it's sent: committed once, or rejected.
create table room_rejections (
  room_id text not null references rooms (id) on delete cascade,
  client_msg_id uuid not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, client_msg_id)
);

-- Who's in a room right now, with whatever the app wants to show about them
-- (say a name). Each instance keeps its own clients' rows fresh, and readers
-- ignore rows older than a few seconds, so the clients of an instance that
-- crashed disappear on their own.
create table room_presence (
  room_id text not null,
  client_id text not null,
  instance_id text not null,
  data jsonb not null,
  last_seen timestamptz not null default now(),
  primary key (room_id, client_id)
);

create index room_presence_last_seen on room_presence (last_seen);
