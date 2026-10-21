-- Validate grants and role/profile invariants at the database boundary.
begin;

create or replace function public.app_validate_role()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare bad_permission boolean;
begin
  new.key:=lower(btrim(new.key));
  new.name:=btrim(new.name);
  new.name_key:=lower(btrim(new.name));
  if tg_op='UPDATE' and new.key is distinct from old.key and exists(select 1 from public.profiles where role_key=old.key) then
    raise exception 'Move users off this role before changing its key' using errcode='23514';
  end if;
  if tg_op='UPDATE' and new.side is distinct from old.side and exists(select 1 from public.profiles where role_key=old.key and active) then
    raise exception 'Move active users before changing this role side' using errcode='23514';
  end if;
  if new.key in ('pending','super_admin') then raise exception 'This role key is reserved' using errcode='23514'; end if;
  if new.side='branch' then
    select exists(select 1 from jsonb_array_elements_text(new.permissions) p where p not in ('requests.create','dispatches.receive','petty_cash.request')) into bad_permission;
    if bad_permission then raise exception 'Branch roles may only use branch request, dispatch receipt, and petty cash permissions' using errcode='23514'; end if;
  end if;
  if new.side='main' and (new.permissions ? 'requests.create' or new.permissions ? 'dispatches.receive') then raise exception 'Main-office roles cannot use branch-only permissions' using errcode='23514'; end if;
  if new.permissions ? 'items.manage' and not (new.permissions ? 'items.view') then raise exception 'Managing items requires item view permission' using errcode='23514'; end if;
  if new.permissions ? 'suppliers.manage' and not (new.permissions ? 'suppliers.view') then raise exception 'Managing suppliers requires supplier view permission' using errcode='23514'; end if;
  if (new.permissions ? 'purchases.manage' or new.permissions ? 'purchases.receive') and not (new.permissions ? 'purchases.view') then raise exception 'Purchase actions require purchase view permission' using errcode='23514'; end if;
  if new.permissions ? 'issues.manage' and not (new.permissions ? 'issues.view') then raise exception 'Issue management requires issue view permission' using errcode='23514'; end if;
  if new.permissions ? 'stock.adjust' and not (new.permissions ? 'stock.view') then raise exception 'Stock adjustments require stock view permission' using errcode='23514'; end if;
  if (new.permissions ? 'petty_cash.approve' or new.permissions ? 'petty_cash.configure') and not (new.permissions ? 'petty_cash.view') then raise exception 'Petty cash management requires petty cash view permission' using errcode='23514'; end if;
  return new;
end
$$;
drop trigger if exists validate_role_permissions on public.roles;
create trigger validate_role_permissions before insert or update on public.roles for each row execute function public.app_validate_role();

create or replace function public.app_validate_profile()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare role_side text; allowed_branch bigint; bad_permission boolean;
begin
  new.email:=lower(btrim(new.email));
  if tg_op='UPDATE' and old.role_key='super_admin' and old.active and
     (new.role_key<>'super_admin' or not new.active) and
     not exists(select 1 from public.profiles where id<>old.id and active and role_key='super_admin') then
    raise exception 'The last active Super Admin cannot be deactivated or demoted' using errcode='23514';
  end if;
  if new.role_key in ('pending','super_admin') then
    if new.role_key='pending' then new.permissions:=null; end if;
    if new.role_key='super_admin' then
      select id into allowed_branch from public.branches where type='main' and active limit 1;
      if new.active and (new.branch_id is null or new.branch_id<>allowed_branch) then raise exception 'Super Admin must be assigned to the main office' using errcode='23514'; end if;
      new.permissions:=null;
    end if;
    return new;
  end if;
  select side into role_side from public.roles where key=new.role_key;
  if role_side is null then raise exception 'Choose a valid role' using errcode='23514'; end if;
  if new.active and new.branch_id is null then raise exception 'An active user must be assigned to a branch' using errcode='23514'; end if;
  if role_side='branch' and new.active and not exists(select 1 from public.branches where id=new.branch_id and type='branch' and active) then
    raise exception 'A branch-side role must be assigned to an active branch' using errcode='23514';
  end if;
  if role_side='main' and new.active and not exists(select 1 from public.branches where id=new.branch_id and type='main' and active) then
    raise exception 'A main-office role must be assigned to the main office' using errcode='23514';
  end if;
  if new.permissions is not null then
    if jsonb_typeof(new.permissions)<>'array' then raise exception 'Permission overrides must be an array' using errcode='23514'; end if;
    if role_side='branch' then
      select exists(select 1 from jsonb_array_elements_text(new.permissions) p where p not in ('requests.create','dispatches.receive','petty_cash.request')) into bad_permission;
    else
      select exists(select 1 from jsonb_array_elements_text(new.permissions) p where p not in (
        'items.view','items.manage','suppliers.view','suppliers.manage','purchases.view','purchases.manage','purchases.receive',
        'issues.view','issues.manage','stock.view','stock.adjust','reports.view','requests.review','dispatches.manage',
        'petty_cash.view','petty_cash.approve','petty_cash.configure','petty_cash.request')) into bad_permission;
    end if;
    if bad_permission then raise exception 'This permission is not available for the selected role side' using errcode='23514'; end if;
    if (new.permissions ? 'items.manage') and not (new.permissions ? 'items.view') then raise exception 'Managing items requires item view permission' using errcode='23514'; end if;
    if (new.permissions ? 'suppliers.manage') and not (new.permissions ? 'suppliers.view') then raise exception 'Managing suppliers requires supplier view permission' using errcode='23514'; end if;
    if ((new.permissions ? 'purchases.manage') or (new.permissions ? 'purchases.receive')) and not (new.permissions ? 'purchases.view') then raise exception 'Purchase actions require purchase view permission' using errcode='23514'; end if;
    if (new.permissions ? 'issues.manage') and not (new.permissions ? 'issues.view') then raise exception 'Issue management requires issue view permission' using errcode='23514'; end if;
    if (new.permissions ? 'stock.adjust') and not (new.permissions ? 'stock.view') then raise exception 'Stock adjustments require stock view permission' using errcode='23514'; end if;
    if ((new.permissions ? 'petty_cash.approve') or (new.permissions ? 'petty_cash.configure')) and not (new.permissions ? 'petty_cash.view') then raise exception 'Petty cash management requires petty cash view permission' using errcode='23514'; end if;
  end if;
  return new;
end
$$;
drop trigger if exists validate_profile_access on public.profiles;
create trigger validate_profile_access before insert or update on public.profiles for each row execute function public.app_validate_profile();

create or replace function public.cancel_branch_request(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.requests%rowtype;
begin
  if uid is null or not public.app_has_permission('requests.create') or not public.app_is_branch_side() then raise exception 'Not allowed to withdraw requests' using errcode='42501'; end if;
  select * into p from public.requests where id=p_request_id for update;
  if not found or p.branch_id is distinct from (select branch_id from public.profiles where id=uid) or p.requested_by<>uid then raise exception 'Request not found' using errcode='P0002'; end if;
  if p.status<>'submitted' then raise exception 'Only a submitted request can be withdrawn' using errcode='23514'; end if;
  update public.requests set status='cancelled' where id=p_request_id;
  perform public.app_write_audit('request.cancel','Request',p_request_id::text,null,null);
  return jsonb_build_object('id',p_request_id,'status','cancelled');
end
$$;

create or replace function public.cancel_petty_cash_request(p_request_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.petty_cash_requests%rowtype;
begin
  if uid is null or not public.app_has_permission('petty_cash.request') then raise exception 'Not allowed to withdraw this request' using errcode='42501'; end if;
  select * into p from public.petty_cash_requests where id=p_request_id for update;
  if not found or p.branch_id is distinct from (select branch_id from public.profiles where id=uid) or p.requested_by<>uid then raise exception 'Request not found' using errcode='P0002'; end if;
  if p.status<>'submitted' then raise exception 'Only a pending request can be withdrawn' using errcode='23514'; end if;
  update public.petty_cash_requests set status='cancelled' where id=p_request_id;
  perform public.app_write_audit('petty_cash.cancel','PettyCashRequest',p_request_id::text,null,null);
  return jsonb_build_object('id',p_request_id,'status','cancelled');
end
$$;

revoke all on function public.create_item(text,text,bigint,text,integer) from public,anon;
revoke all on function public.create_purchase(bigint,date,text,text,jsonb) from public,anon;
revoke all on function public.cancel_purchase(bigint) from public,anon;
revoke all on function public.receive_purchase(bigint,jsonb) from public,anon;
revoke all on function public.create_stock_adjustment(bigint,bigint,text,integer,text,text) from public,anon;
revoke all on function public.create_office_issue(bigint,text,text,date,text,jsonb) from public,anon;
revoke all on function public.cancel_office_issue(bigint,text) from public,anon;
revoke all on function public.create_branch_request(text,jsonb) from public,anon;
revoke all on function public.cancel_branch_request(bigint) from public,anon;
revoke all on function public.review_branch_request(bigint,jsonb,boolean) from public,anon;
revoke all on function public.create_dispatch(bigint,date,bigint,jsonb) from public,anon;
revoke all on function public.receive_dispatch(bigint,jsonb) from public,anon;
revoke all on function public.close_dispatch(bigint,text,text) from public,anon;
revoke all on function public.create_petty_cash_request(numeric,text) from public,anon;
revoke all on function public.cancel_petty_cash_request(bigint) from public,anon;
revoke all on function public.review_petty_cash_request(bigint,boolean,numeric,text) from public,anon;
revoke all on function public.record_petty_cash_expense(numeric,text,date) from public,anon;
revoke all on function public.reverse_petty_cash_expense(bigint) from public,anon;
revoke all on function public.set_petty_cash_low_level(numeric) from public,anon;
grant execute on function public.cancel_branch_request(bigint) to authenticated;
grant execute on function public.cancel_petty_cash_request(bigint) to authenticated;

commit;
