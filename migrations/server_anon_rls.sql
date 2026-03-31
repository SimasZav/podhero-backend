-- Migration: RLS policies for server.js using anon key
-- Run in Supabase SQL editor after add_unsubscribe_token.sql

-- server.js needs to read/write users (subscribe, unsubscribe, get user)
create policy "anon_server_users" on users
  for all to anon using (true) with check (true);

-- server.js needs to read/write user_preferences (subscribe, update prefs)
create policy "anon_server_prefs" on user_preferences
  for all to anon using (true) with check (true);

-- server.js needs to read digests (list endpoint)
create policy "anon_server_digests" on digests
  for select to anon using (true);

-- server.js needs to read podcast_sources (preview endpoint)
create policy "anon_server_sources" on podcast_sources
  for select to anon using (true);
