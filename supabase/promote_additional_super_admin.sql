-- Promote an additional, already-created Supabase Auth account to Super Admin.
-- First create the account in Supabase Dashboard -> Authentication -> Users -> Add user.
-- Replace the email below with the NEW account's confirmed email before running.
-- Run this file in that project's Supabase SQL Editor. Do not put a password or API key here.
begin;
do $$
declare
  admin_id uuid;
  main_id bigint;
  auth_email text;
  auth_name text;
  email_confirmed timestamptz;
  admin_email text := lower(btrim('new-admin@example.com'));
begin
  select u.id, lower(u.email), coalesce(u.raw_user_meta_data->>'name',''), u.email_confirmed_at
    into admin_id, auth_email, auth_name, email_confirmed
  from auth.users u
  where lower(u.email)=admin_email;

  if admin_id is null then
    raise exception 'No Supabase Auth account found for %. Create the account first and use its exact email.', admin_email;
  end if;
  if email_confirmed is null then
    raise exception 'The email for % is not confirmed. Confirm the account in Supabase Auth, then run this script again.', admin_email;
  end if;

  select id into main_id from public.branches where type='main' and active limit 1;
  if main_id is null then
    raise exception 'No active Main Office branch exists. Run the initial administrator bootstrap first.';
  end if;

  insert into public.profiles as existing_profile(id,email,name,role_key,permissions,branch_id,active)
    values(admin_id,auth_email,coalesce(nullif(auth_name,''),'Super Admin'),'super_admin',null,main_id,true)
    on conflict(id) do update set email=excluded.email,
      name=coalesce(nullif(existing_profile.name,''),excluded.name),
      role_key='super_admin',permissions=null,branch_id=main_id,active=true;
end
$$;
commit;
