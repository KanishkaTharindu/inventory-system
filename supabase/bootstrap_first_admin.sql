-- Run once in Supabase SQL Editor after applying migrations and confirming the intended
-- administrator account. Replace the email before running.
begin;
do $$
declare
  admin_id uuid;
  main_id bigint;
  auth_email text;
  auth_name text;
  email_confirmed timestamptz;
  admin_email text := lower('navodyamanamendra19@gmail.com');
begin
  if exists(select 1 from public.profiles where active and role_key='super_admin') then
    raise exception 'A Super Admin is already active. This bootstrap is one-time only.';
  end if;
  select u.id,lower(u.email),coalesce(u.raw_user_meta_data->>'name',''),u.email_confirmed_at
    into admin_id,auth_email,auth_name,email_confirmed
  from auth.users u where lower(u.email)=admin_email;
  if admin_id is null then
    raise exception 'No Supabase Auth account found for %. Create that account in Office Stock, then replace the email in this script.',admin_email;
  end if;
  if email_confirmed is null then
    raise exception 'The email for % is not confirmed. Confirm it, then run this script again.',admin_email;
  end if;
  insert into public.branches(name,code,type) values('Main Office','MAIN','main')
    on conflict(code) do update set type='main' returning id into main_id;
  insert into public.profiles as existing_profile(id,email,name,role_key,permissions,branch_id,active)
    values(admin_id,auth_email,coalesce(nullif(auth_name,''),'Super Admin'),'super_admin',null,main_id,true)
    on conflict(id) do update set email=excluded.email,
      name=coalesce(nullif(existing_profile.name,''),excluded.name),role_key='super_admin',permissions=null,
      branch_id=main_id,active=true;
end
$$;
commit;
