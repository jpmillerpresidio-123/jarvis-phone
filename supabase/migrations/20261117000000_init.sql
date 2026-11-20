-- Personal AI Assistant: initial schema.
-- The backend uses the service-role key (bypasses RLS). The dashboard uses the
-- signed-in owner's session, so every table has RLS that admits only the owner.

create extension if not exists pgcrypto;

-- Who owns this installation. Exactly one row.
create table if not exists app_owner (
  id boolean primary key default true check (id),
  email text not null
);

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_owner
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) and coalesce((auth.jwt() -> 'email_verified')::boolean, (auth.jwt() -> 'user_metadata' ->> 'email_verified')::boolean, true);
$$;

create table if not exists settings (
  id boolean primary key default true check (id),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into settings (id) values (true) on conflict do nothing;

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  content text not null check (char_length(content) between 1 and 2000),
  category text not null default 'other'
    check (category in ('preference','instruction','project','contact','decision','task','other')),
  pinned boolean not null default false,
  source text not null default 'assistant' check (source in ('call','dashboard','assistant')),
  search tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists memories_search_idx on memories using gin (search);

create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  call_sid text not null unique,
  from_number text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_sec integer,
  status text not null default 'in_progress'
    check (status in ('in_progress','completed','failed','rejected')),
  summary text,
  errors jsonb not null default '[]'::jsonb
);
create index if not exists calls_started_idx on calls (started_at desc);

create table if not exists transcript_lines (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  role text not null check (role in ('caller','assistant','tool','system')),
  text text not null,
  at timestamptz not null default now()
);
create index if not exists transcript_call_idx on transcript_lines (call_id, id);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  integration_id text not null,
  tool_name text not null,
  summary text not null,
  status text not null
    check (status in ('pending_confirmation','running','completed','failed','cancelled','blocked')),
  risk text not null check (risk in ('read','write','consequential','blocked')),
  input jsonb,
  result text,
  error text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_created_idx on tasks (created_at desc);

create table if not exists usage_events (
  id bigserial primary key,
  kind text not null check (kind in ('claude','twilio')),
  call_id uuid references calls(id) on delete set null,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  minutes numeric,
  cost_usd numeric not null default 0,
  at timestamptz not null default now()
);
create index if not exists usage_at_idx on usage_events (at desc);

-- Secrets column holds an AES-256-GCM envelope produced by the backend.
-- The dashboard never selects it (see the view below).
create table if not exists integrations (
  id text primary key,
  kind text not null check (kind in ('google','shopify','mcp')),
  display_name text not null,
  enabled boolean not null default true,
  secret text,
  config jsonb not null default '{}'::jsonb,
  tool_policies jsonb not null default '{}'::jsonb,
  status text not null default 'untested'
    check (status in ('untested','connected','error','needs_auth','disconnected')),
  last_tested_at timestamptz,
  last_error text,
  tool_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists audit_at_idx on audit_log (at desc);

-- Row level security: owner-only, and the dashboard can never read secrets.
alter table app_owner enable row level security;
alter table settings enable row level security;
alter table memories enable row level security;
alter table calls enable row level security;
alter table transcript_lines enable row level security;
alter table tasks enable row level security;
alter table usage_events enable row level security;
alter table integrations enable row level security;
alter table audit_log enable row level security;

create policy owner_read_settings on settings for select using (is_owner());
create policy owner_write_settings on settings for update using (is_owner());
create policy owner_all_memories on memories for all using (is_owner()) with check (is_owner());
create policy owner_read_calls on calls for select using (is_owner());
create policy owner_delete_calls on calls for delete using (is_owner());
create policy owner_read_transcript on transcript_lines for select using (is_owner());
create policy owner_read_tasks on tasks for select using (is_owner());
create policy owner_read_usage on usage_events for select using (is_owner());
create policy owner_read_audit on audit_log for select using (is_owner());
-- integrations: no direct policy -> dashboard reads only via the safe view.

create or replace view integrations_public with (security_invoker = false) as
  select id, kind, display_name, enabled, config, tool_policies, status,
         last_tested_at, last_error, tool_count, updated_at
  from integrations
  where is_owner();

revoke all on integrations from anon, authenticated;
grant select on integrations_public to authenticated;
