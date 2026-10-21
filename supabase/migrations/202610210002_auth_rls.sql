-- Supabase Auth profiles, role checks, RLS policies, and minimum table grants.
begin;

insert into public.roles(key,name,name_key,description,side,permissions) values
('stock_officer','Stock Officer','stock officer','Records stock and handles branch requests','main',
 '["items.view","items.manage","suppliers.view","suppliers.manage","purchases.view","purchases.manage","purchases.receive","issues.view","issues.manage","stock.view","stock.adjust","reports.view","requests.review","dispatches.manage","petty_cash.request"]'::jsonb),
('viewer','Viewer / Approver','viewer approver','Read-only access to reports and stock','main',
 '["items.view","suppliers.view","purchases.view","issues.view","stock.view","reports.view"]'::jsonb),
('branch_user','Branch User','branch user','Requests items and confirms receipts for a branch','branch',
 '["requests.create","dispatches.receive","petty_cash.request"]'::jsonb)
on conflict (key) do nothing;

create or replace function public.app_is_active()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active)
$$;
create or replace function public.app_is_super_admin()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and p.role_key='super_admin')
$$;
create or replace function public.app_has_permission(permission_key text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(
    select 1 from public.profiles p left join public.roles r on r.key=p.role_key
    where p.id=auth.uid() and p.active and
      (p.role_key='super_admin' or coalesce(p.permissions,r.permissions,'[]'::jsonb) ? permission_key)
  )
$$;
create or replace function public.app_is_branch_side()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles p join public.roles r on r.key=p.role_key
    where p.id=auth.uid() and p.active and p.role_key<>'super_admin' and r.side='branch')
$$;
create or replace function public.app_can_access_branch(target_branch_id bigint)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles p where p.id=auth.uid() and p.active and
    (p.role_key='super_admin' or not public.app_is_branch_side() or
     (target_branch_id is not null and p.branch_id=target_branch_id)))
$$;
create or replace function public.app_branch_module_enabled()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.app_is_active() and coalesce((select branch_module_enabled from public.app_settings where id=1),false)
$$;

create or replace function public.app_write_audit(action_key text,record_kind text,record_key text,
                                                   old_data jsonb default null,new_data jsonb default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce((select audit_logging_enabled from public.app_settings where id=1),true) then
    insert into public.audit_logs(user_id,action,record_type,record_id,old_value,new_value)
    values(auth.uid(),left(action_key,60),left(record_kind,40),left(record_key,40),old_data,new_data);
  end if;
end
$$;
create or replace function public.app_next_number(prefix text,yearly boolean default true)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare counter_key text; next_seq integer; current_year integer:=extract(year from now())::integer;
begin
  counter_key:=upper(prefix)||case when yearly then ':'||current_year::text else '' end;
  insert into public.counters(key,seq) values(counter_key,1)
  on conflict(key) do update set seq=public.counters.seq+1 returning seq into next_seq;
  if yearly then return upper(prefix)||'-'||current_year::text||'-'||lpad(next_seq::text,4,'0'); end if;
  return upper(prefix)||'-'||lpad(next_seq::text,4,'0');
end
$$;

-- New auth users start inactive. A Super Admin must assign a branch and role before they can use data.
create or replace function public.app_new_auth_profile()
returns trigger language plpgsql security definer set search_path=public,auth,pg_temp as $$
begin
  insert into public.profiles(id,email,name,role_key,active)
  values(new.id,lower(new.email),coalesce(new.raw_user_meta_data->>'name',''),'pending',false)
  on conflict(id) do update set email=lower(excluded.email);
  return new;
end
$$;
drop trigger if exists app_auth_user_created on auth.users;
create trigger app_auth_user_created after insert on auth.users
for each row execute function public.app_new_auth_profile();

create or replace function public.app_update_timestamp()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  new.updated_at:=now();
  return new;
end
$$;
do $$
declare tab text;
begin
  foreach tab in array array['branches','roles','profiles','categories','suppliers','items','app_settings','purchases','office_issues','requests','dispatches','petty_cash_requests'] loop
    execute format('drop trigger if exists %I_updated_at on public.%I',tab,tab);
    execute format('create trigger %I_updated_at before update on public.%I for each row execute function public.app_update_timestamp()',tab,tab);
  end loop;
end
$$;

alter table public.branches enable row level security;
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.suppliers enable row level security;
alter table public.items enable row level security;
alter table public.app_settings enable row level security;
alter table public.counters enable row level security;
alter table public.audit_logs enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;
alter table public.office_issues enable row level security;
alter table public.office_issue_lines enable row level security;
alter table public.requests enable row level security;
alter table public.request_lines enable row level security;
alter table public.dispatches enable row level security;
alter table public.dispatch_lines enable row level security;
alter table public.stock_ledger enable row level security;
alter table public.petty_cash_requests enable row level security;
alter table public.petty_cash_entries enable row level security;

drop policy if exists active_roles_read on public.roles;
create policy active_roles_read on public.roles for select to authenticated using(public.app_is_active());
drop policy if exists admin_roles_manage on public.roles;
create policy admin_roles_manage on public.roles for all to authenticated using(public.app_is_super_admin()) with check(public.app_is_super_admin());
drop policy if exists profile_self_or_admin_read on public.profiles;
create policy profile_self_or_admin_read on public.profiles for select to authenticated using(id=auth.uid() or public.app_is_super_admin());
drop policy if exists admin_profiles_manage on public.profiles;
create policy admin_profiles_manage on public.profiles for all to authenticated using(public.app_is_super_admin()) with check(public.app_is_super_admin());
drop policy if exists branch_read_scope on public.branches;
create policy branch_read_scope on public.branches for select to authenticated using(public.app_is_active() and (not public.app_is_branch_side() or id=(select branch_id from public.profiles where id=auth.uid())));
drop policy if exists admin_branches_manage on public.branches;
create policy admin_branches_manage on public.branches for all to authenticated using(public.app_is_super_admin()) with check(public.app_is_super_admin());

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated using(public.app_has_permission('items.view') or public.app_has_permission('reports.view'));
drop policy if exists categories_manage on public.categories;
create policy categories_manage on public.categories for all to authenticated using(public.app_has_permission('items.manage')) with check(public.app_has_permission('items.manage'));
drop policy if exists suppliers_read on public.suppliers;
create policy suppliers_read on public.suppliers for select to authenticated using(public.app_has_permission('suppliers.view') or public.app_has_permission('purchases.view') or public.app_has_permission('reports.view'));
drop policy if exists suppliers_manage on public.suppliers;
create policy suppliers_manage on public.suppliers for all to authenticated using(public.app_has_permission('suppliers.manage')) with check(public.app_has_permission('suppliers.manage'));
drop policy if exists items_read on public.items;
create policy items_read on public.items for select to authenticated using(public.app_has_permission('items.view') or public.app_has_permission('requests.create') or public.app_has_permission('purchases.view') or public.app_has_permission('issues.view') or public.app_has_permission('stock.view') or public.app_has_permission('reports.view') or public.app_has_permission('dispatches.manage') or public.app_has_permission('dispatches.receive'));
drop policy if exists items_manage on public.items;
create policy items_manage on public.items for all to authenticated using(public.app_has_permission('items.manage')) with check(public.app_has_permission('items.manage'));

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using(public.app_is_active());
drop policy if exists settings_admin_update on public.app_settings;
create policy settings_admin_update on public.app_settings for update to authenticated using(public.app_is_super_admin()) with check(public.app_is_super_admin());
drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs for select to authenticated using(public.app_is_super_admin());

drop policy if exists purchases_read_scope on public.purchases;
create policy purchases_read_scope on public.purchases for select to authenticated using((public.app_has_permission('purchases.view') or public.app_has_permission('reports.view')) and public.app_can_access_branch(branch_id));
drop policy if exists purchase_lines_read_scope on public.purchase_lines;
create policy purchase_lines_read_scope on public.purchase_lines for select to authenticated using(exists(select 1 from public.purchases p where p.id=purchase_id and (public.app_has_permission('purchases.view') or public.app_has_permission('reports.view')) and public.app_can_access_branch(p.branch_id)));
drop policy if exists issues_read_scope on public.office_issues;
create policy issues_read_scope on public.office_issues for select to authenticated using((public.app_has_permission('issues.view') or public.app_has_permission('reports.view')) and public.app_can_access_branch(branch_id));
drop policy if exists issue_lines_read_scope on public.office_issue_lines;
create policy issue_lines_read_scope on public.office_issue_lines for select to authenticated using(exists(select 1 from public.office_issues i where i.id=issue_id and (public.app_has_permission('issues.view') or public.app_has_permission('reports.view')) and public.app_can_access_branch(i.branch_id)));

drop policy if exists requests_read_scope on public.requests;
create policy requests_read_scope on public.requests for select to authenticated using(
  (public.app_has_permission('requests.create') and branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('requests.review') and public.app_can_access_branch(branch_id)) or
  (public.app_has_permission('dispatches.manage') and public.app_can_access_branch(branch_id))
);
drop policy if exists request_lines_read_scope on public.request_lines;
create policy request_lines_read_scope on public.request_lines for select to authenticated using(exists(select 1 from public.requests r where r.id=request_id and (
  (public.app_has_permission('requests.create') and r.branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('requests.review') and public.app_can_access_branch(r.branch_id)) or
  (public.app_has_permission('dispatches.manage') and public.app_can_access_branch(r.branch_id))
)));

drop policy if exists dispatches_read_scope on public.dispatches;
create policy dispatches_read_scope on public.dispatches for select to authenticated using(
  (public.app_has_permission('dispatches.receive') and destination_id=(select branch_id from public.profiles where id=auth.uid())) or
  ((public.app_has_permission('dispatches.manage') or public.app_has_permission('reports.view')) and public.app_can_access_branch(destination_id))
);
drop policy if exists dispatch_lines_read_scope on public.dispatch_lines;
create policy dispatch_lines_read_scope on public.dispatch_lines for select to authenticated using(exists(select 1 from public.dispatches d where d.id=dispatch_id and (
  (public.app_has_permission('dispatches.receive') and d.destination_id=(select branch_id from public.profiles where id=auth.uid())) or
  ((public.app_has_permission('dispatches.manage') or public.app_has_permission('reports.view')) and public.app_can_access_branch(d.destination_id))
)));

drop policy if exists stock_read_scope on public.stock_ledger;
create policy stock_read_scope on public.stock_ledger for select to authenticated using(
  (((public.app_has_permission('stock.view') or public.app_has_permission('reports.view')) and
    ((not in_transit and public.app_can_access_branch(branch_id)) or (in_transit and not public.app_is_branch_side()))) or
   (public.app_has_permission('items.view') and not in_transit and branch_id=(select branch_id from public.profiles where id=auth.uid())))
);
drop policy if exists petty_cash_requests_read_scope on public.petty_cash_requests;
create policy petty_cash_requests_read_scope on public.petty_cash_requests for select to authenticated using(
  (public.app_has_permission('petty_cash.request') and branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('petty_cash.view') and public.app_can_access_branch(branch_id))
);
drop policy if exists petty_cash_entries_read_scope on public.petty_cash_entries;
create policy petty_cash_entries_read_scope on public.petty_cash_entries for select to authenticated using(
  (public.app_has_permission('petty_cash.request') and branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('petty_cash.view') and public.app_can_access_branch(branch_id))
);

revoke all on all tables in schema public from anon,authenticated;
grant usage on schema public to authenticated;
grant select on public.branches,public.roles,public.profiles,public.categories,public.suppliers,public.items,public.app_settings,
  public.audit_logs,public.purchases,public.purchase_lines,public.office_issues,public.office_issue_lines,public.requests,
  public.request_lines,public.dispatches,public.dispatch_lines,public.stock_ledger,public.petty_cash_requests,public.petty_cash_entries to authenticated;
grant insert,update,delete on public.categories,public.suppliers,public.items,public.branches,public.roles to authenticated;
grant update(name,role_key,permissions,branch_id,active) on public.profiles to authenticated;
grant update on public.app_settings to authenticated;
grant usage,select on all sequences in schema public to authenticated;

revoke all on function public.app_is_active() from public,anon;
revoke all on function public.app_is_super_admin() from public,anon;
revoke all on function public.app_has_permission(text) from public,anon;
revoke all on function public.app_is_branch_side() from public,anon;
revoke all on function public.app_can_access_branch(bigint) from public,anon;
revoke all on function public.app_branch_module_enabled() from public,anon;
revoke all on function public.app_write_audit(text,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.app_next_number(text,boolean) from public,anon,authenticated;
revoke all on function public.app_new_auth_profile() from public,anon,authenticated;
grant execute on function public.app_is_active() to authenticated;
grant execute on function public.app_is_super_admin() to authenticated;
grant execute on function public.app_has_permission(text) to authenticated;
grant execute on function public.app_is_branch_side() to authenticated;
grant execute on function public.app_can_access_branch(bigint) to authenticated;
grant execute on function public.app_branch_module_enabled() to authenticated;

commit;
