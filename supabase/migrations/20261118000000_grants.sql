-- Newer Supabase projects don't grant table access to API roles automatically.
-- The backend uses the service_role key, so give that role access to the app's tables.
-- (The dashboard goes through the backend, so anon/authenticated get nothing extra here.)

grant usage on schema public to service_role;

grant select, insert, update, delete on
  app_owner, settings, memories, calls, transcript_lines, tasks,
  usage_events, integrations, audit_log
to service_role;

grant usage, select on all sequences in schema public to service_role;
grant execute on function is_owner() to service_role, authenticated;
