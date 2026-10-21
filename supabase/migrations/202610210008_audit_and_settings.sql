-- Audit authorized direct CRUD and route settings through an audited RPC.
begin;

create or replace function public.app_audit_row()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare old_json jsonb; new_json jsonb; row_key text;
begin
  if tg_op='INSERT' then
    new_json:=to_jsonb(new); row_key:=coalesce(new_json->>'id',new_json->>'key','');
  elsif tg_op='DELETE' then
    old_json:=to_jsonb(old); row_key:=coalesce(old_json->>'id',old_json->>'key','');
  else
    old_json:=to_jsonb(old); new_json:=to_jsonb(new); row_key:=coalesce(new_json->>'id',new_json->>'key','');
  end if;
  if coalesce((select audit_logging_enabled from public.app_settings where id=1),true) then
    insert into public.audit_logs(user_id,action,record_type,record_id,old_value,new_value)
    values(auth.uid(),left(tg_table_name||'.'||lower(tg_op),60),left(tg_table_name,40),left(row_key,40),old_json,new_json);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end
$$;

do $$
declare tab text;
begin
  foreach tab in array array['branches','roles','profiles','categories','suppliers','items'] loop
    execute format('drop trigger if exists audit_%I_row on public.%I',tab,tab);
    execute format('create trigger audit_%I_row after insert or update or delete on public.%I for each row execute function public.app_audit_row()',tab,tab);
  end loop;
end
$$;

create or replace function public.update_app_settings(p_company_name text,p_branch_module_enabled boolean,p_audit_logging_enabled boolean)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.app_is_super_admin() then raise exception 'Not allowed to change company settings' using errcode='42501'; end if;
  if btrim(coalesce(p_company_name,''))='' then raise exception 'Company name is required' using errcode='22023'; end if;
  update public.app_settings set company_name=left(btrim(p_company_name),120),branch_module_enabled=p_branch_module_enabled,
    audit_logging_enabled=p_audit_logging_enabled where id=1;
  perform public.app_write_audit('settings.update','Setting','1',null,jsonb_build_object('company_name',left(btrim(p_company_name),120),
    'branch_module_enabled',p_branch_module_enabled,'audit_logging_enabled',p_audit_logging_enabled));
  return jsonb_build_object('company_name',left(btrim(p_company_name),120),'branch_module_enabled',p_branch_module_enabled,
    'audit_logging_enabled',p_audit_logging_enabled);
end
$$;

drop policy if exists requests_read_scope on public.requests;
create policy requests_read_scope on public.requests for select to authenticated using(public.app_branch_module_enabled() and (
  (public.app_has_permission('requests.create') and branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('requests.review') and public.app_can_access_branch(branch_id)) or
  (public.app_has_permission('dispatches.manage') and public.app_can_access_branch(branch_id))
));
drop policy if exists request_lines_read_scope on public.request_lines;
create policy request_lines_read_scope on public.request_lines for select to authenticated using(public.app_branch_module_enabled() and exists(select 1 from public.requests r where r.id=request_id and (
  (public.app_has_permission('requests.create') and r.branch_id=(select branch_id from public.profiles where id=auth.uid())) or
  (public.app_has_permission('requests.review') and public.app_can_access_branch(r.branch_id)) or
  (public.app_has_permission('dispatches.manage') and public.app_can_access_branch(r.branch_id))
)));
drop policy if exists dispatches_read_scope on public.dispatches;
create policy dispatches_read_scope on public.dispatches for select to authenticated using(public.app_branch_module_enabled() and (
  (public.app_has_permission('dispatches.receive') and destination_id=(select branch_id from public.profiles where id=auth.uid())) or
  ((public.app_has_permission('dispatches.manage') or public.app_has_permission('reports.view')) and public.app_can_access_branch(destination_id))
));
drop policy if exists dispatch_lines_read_scope on public.dispatch_lines;
create policy dispatch_lines_read_scope on public.dispatch_lines for select to authenticated using(public.app_branch_module_enabled() and exists(select 1 from public.dispatches d where d.id=dispatch_id and (
  (public.app_has_permission('dispatches.receive') and d.destination_id=(select branch_id from public.profiles where id=auth.uid())) or
  ((public.app_has_permission('dispatches.manage') or public.app_has_permission('reports.view')) and public.app_can_access_branch(d.destination_id))
)));

revoke update on public.app_settings from authenticated;
revoke all on function public.update_app_settings(text,boolean,boolean) from public,anon;
grant execute on function public.update_app_settings(text,boolean,boolean) to authenticated;
revoke all on function public.app_audit_row() from public,anon;

commit;
