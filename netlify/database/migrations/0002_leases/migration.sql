-- Leases, for work only one instance should do at a time (the demo's
-- simulated users on the server). The holder renews its lease while it does
-- the work, so if its instance stops or crashes, another one takes over once
-- the lease expires.
create table leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);
