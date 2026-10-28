create table connectors (
  id uuid primary key,
  name text unique not null,
  token_sha256 bytea unique not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz
);

create table pairings (
  connector_id uuid primary key references connectors(id) on delete cascade,
  tg_user_id bigint unique not null,
  tg_chat_id bigint not null,
  user_display text not null,
  created_at timestamptz not null default now()
);

create table pairing_codes (
  code text primary key,
  connector_id uuid not null references connectors(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table message_sessions (
  tg_chat_id bigint not null,
  tg_message_id bigint not null,
  connector_id uuid not null references connectors(id) on delete cascade,
  agent_id text not null,
  session_id text not null,
  cwd text not null,
  created_at timestamptz not null default now(),
  primary key (tg_chat_id, tg_message_id)
);

create table chat_settings (
  tg_chat_id bigint primary key,
  "verbose" boolean not null default false -- quoted: VERBOSE is a reserved word
);

-- R15: Telegram callback_data is at most 64 bytes, so every inline button carries a short id.
create table callbacks (
  short_id text primary key,
  connector_id uuid not null references connectors(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- R2/R9: durable connector messages already shown in Telegram.
create table delivered (
  connector_id uuid not null references connectors(id) on delete cascade,
  msg_id text not null,
  created_at timestamptz not null default now(),
  primary key (connector_id, msg_id)
);

-- Hourly cleanup (repo.ts) deletes by these columns.
create index message_sessions_created_at on message_sessions (created_at);
create index callbacks_expires_at on callbacks (expires_at);
create index delivered_created_at on delivered (created_at);
