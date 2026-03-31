-- Migration: add unsubscribe_token to users
-- Run in Supabase SQL editor

alter table users
  add column if not exists unsubscribe_token uuid default gen_random_uuid();

-- Backfill existing users who don't have a token yet
update users
  set unsubscribe_token = gen_random_uuid()
  where unsubscribe_token is null;

-- Index for fast token lookups
create index if not exists users_unsubscribe_token_idx on users (unsubscribe_token);
