-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).

create table if not exists public.rooms (
  code        text primary key,
  version     integer     not null default 1,
  state       jsonb       not null,
  updated_at  timestamptz not null default now()
);

create index if not exists rooms_updated_at_idx on public.rooms (updated_at);

-- Lock the table down: the browser never talks to Supabase directly.
-- Only the server (service-role key) can read/write, so the secret
-- "which statement is the lie" can never leak to players.
alter table public.rooms enable row level security;
-- (no policies on purpose)

-- Presence heartbeat: updates one player's lastSeen atomically, without
-- bumping `version`, so it never conflicts with real game updates.
create or replace function public.touch_player(p_code text, p_pid text, p_ts bigint)
returns void
language sql
as $$
  update public.rooms
     set state = jsonb_set(state, array['players', p_pid, 'lastSeen'], to_jsonb(p_ts), false),
         updated_at = now()
   where code = p_code
     and state -> 'players' ? p_pid;
$$;

revoke all on function public.touch_player(text, text, bigint) from public, anon, authenticated;
grant execute on function public.touch_player(text, text, bigint) to service_role;

-- Optional housekeeping: delete rooms untouched for 2 days (needs the pg_cron extension).
-- select cron.schedule('ttl-cleanup', '0 * * * *',
--   $$ delete from public.rooms where updated_at < now() - interval '2 days' $$);
