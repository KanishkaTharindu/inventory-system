-- Remove PostgreSQL's default PUBLIC EXECUTE grant from every desktop schema function.
-- Authenticated users retain only the explicit grants installed by earlier migrations.
begin;

revoke execute on all functions in schema public from public, anon;

commit;
