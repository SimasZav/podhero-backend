-- PodHero Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── USERS ───────────────────────────────────────────────────
create table users (
  id          uuid primary key default uuid_generate_v4(),
  email       text unique not null,
  created_at  timestamptz default now(),
  active      boolean default true
);

-- ─── USER PREFERENCES ────────────────────────────────────────
create table user_preferences (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references users(id) on delete cascade,
  interests   text[] default '{}',       -- e.g. ['tech', 'startup', 'finance']
  podcasts    text[] default '{}',       -- e.g. ['Acquired', 'Lex Fridman Podcast']
  frequency   text default 'weekly',     -- 'weekly' | 'daily'
  updated_at  timestamptz default now()
);

-- ─── PODCAST SOURCES ─────────────────────────────────────────
create table podcast_sources (
  id          uuid primary key default uuid_generate_v4(),
  title       text not null,
  feed_url    text unique not null,
  image_url   text,
  categories  text[] default '{}',
  last_fetched timestamptz,
  created_at  timestamptz default now()
);

-- ─── EPISODES ────────────────────────────────────────────────
create table episodes (
  id           uuid primary key default uuid_generate_v4(),
  podcast_id   uuid references podcast_sources(id) on delete cascade,
  guid         text unique not null,     -- RSS guid for dedup
  title        text not null,
  description  text,
  audio_url    text,
  duration     text,
  pub_date     timestamptz,
  fetched_at   timestamptz default now()
);

-- ─── SUMMARIES ───────────────────────────────────────────────
create table summaries (
  id           uuid primary key default uuid_generate_v4(),
  episode_id   uuid references episodes(id) on delete cascade unique,
  summary      text,
  takeaways    text[],
  quote        text,
  topics       text[],
  generated_at timestamptz default now()
);

-- ─── DIGESTS ─────────────────────────────────────────────────
create table digests (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references users(id) on delete cascade,
  week_of      date not null,
  intro        text,
  episode_ids  uuid[],                   -- ordered list of included episodes
  sent_at      timestamptz,
  created_at   timestamptz default now()
);

-- ─── INDEXES ─────────────────────────────────────────────────
create index on episodes (podcast_id, pub_date desc);
create index on episodes (pub_date desc);
create index on digests (user_id, week_of desc);
create index on user_preferences (user_id);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
alter table users enable row level security;
alter table user_preferences enable row level security;
alter table digests enable row level security;

-- Users can only read/update their own data
create policy "users_self" on users
  for all using (auth.uid()::text = id::text);

create policy "prefs_self" on user_preferences
  for all using (
    user_id in (select id from users where auth.uid()::text = id::text)
  );

create policy "digests_self" on digests
  for select using (
    user_id in (select id from users where auth.uid()::text = id::text)
  );

-- Service role can read everything (for the worker)
create policy "service_all_episodes" on episodes for all to service_role using (true);
create policy "service_all_summaries" on summaries for all to service_role using (true);
create policy "service_all_digests" on digests for all to service_role using (true);
create policy "service_all_sources" on podcast_sources for all to service_role using (true);
