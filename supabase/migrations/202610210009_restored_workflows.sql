-- Restore catalog deletion, purchase editing, audit cleanup, and stock retention workflows.
-- All maintenance operations are authenticated, permission checked, and transactional.
begin;

create or replace function public.app_sync_auth_profile()
returns trigger language plpgsql security definer set search_path=public,auth,pg_temp as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email=lower(new.email) where id=new.id;
  end if;
  return new;
end
$$;
drop trigger if exists app_auth_email_updated on auth.users;
create trigger app_auth_email_updated after update of email on auth.users
for each row execute function public.app_sync_auth_profile();

create or replace function public.app_validate_branch()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' and old.type='main' and (new.type<>'main' or not new.active) then
    raise exception 'The main office must remain active and keep its type' using errcode='23514';
  end if;
  if tg_op='UPDATE' and new.type is distinct from old.type and exists(select 1 from public.profiles where branch_id=old.id) then
    raise exception 'Move users before changing this branch type' using errcode='23514';
  end if;
  if tg_op='UPDATE' and old.active and not new.active and exists(select 1 from public.profiles where branch_id=old.id and active) then
    raise exception 'Move or deactivate assigned users before deactivating this branch' using errcode='23514';
  end if;
  return new;
end
$$;
drop trigger if exists validate_branch_changes on public.branches;
create trigger validate_branch_changes before update on public.branches for each row execute function public.app_validate_branch();

create or replace function public.app_validate_role_delete()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.profiles where role_key=old.key) then raise exception 'Move users off this role before deleting it' using errcode='23514'; end if;
  return old;
end
$$;
drop trigger if exists validate_role_delete on public.roles;
create trigger validate_role_delete before delete on public.roles for each row execute function public.app_validate_role_delete();

create or replace function public.update_purchase(
  p_purchase_id bigint,p_supplier_id bigint,p_purchase_date date,p_invoice_ref text,p_notes text,p_lines jsonb
)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.purchases%rowtype; line jsonb; item_key bigint; qty integer; cost numeric;
begin
  if uid is null or not public.app_has_permission('purchases.manage') or public.app_is_branch_side() then
    raise exception 'Not allowed to edit purchases' using errcode='42501';
  end if;
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found or not public.app_can_access_branch(p.branch_id) then raise exception 'Purchase not found' using errcode='P0002'; end if;
  if p.status<>'ordered' or exists(select 1 from public.purchase_lines where purchase_id=p_purchase_id and quantity_received>0) then
    raise exception 'A purchase can only be edited before any goods are received' using errcode='23514';
  end if;
  if not exists(select 1 from public.suppliers where id=p_supplier_id and active) then raise exception 'Choose an active supplier' using errcode='22023'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one purchase line' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity_ordered')::integer; cost:=(line->>'unit_cost')::numeric;
    if qty<=0 or cost<0 or not exists(select 1 from public.items where id=item_key and active) then
      raise exception 'Purchase line has an invalid item, quantity, or cost' using errcode='22023';
    end if;
  end loop;
  update public.purchases set supplier_id=p_supplier_id,purchase_date=p_purchase_date,
    invoice_ref=left(coalesce(p_invoice_ref,''),80),notes=left(coalesce(p_notes,''),500) where id=p_purchase_id;
  delete from public.purchase_lines where purchase_id=p_purchase_id;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity_ordered')::integer; cost:=(line->>'unit_cost')::numeric;
    insert into public.purchase_lines(purchase_id,item_id,quantity_ordered,unit_cost) values(p_purchase_id,item_key,qty,cost);
  end loop;
  perform public.app_write_audit('purchase.update','Purchase',p_purchase_id::text,null,jsonb_build_object('supplier_id',p_supplier_id,'line_count',jsonb_array_length(p_lines)));
  return jsonb_build_object('id',p_purchase_id,'status','ordered');
end
$$;

create or replace function public.delete_item(p_item_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare i public.items%rowtype; has_history boolean;
begin
  if not public.app_has_permission('items.manage') or public.app_is_branch_side() then raise exception 'Not allowed to delete items' using errcode='42501'; end if;
  select * into i from public.items where id=p_item_id for update;
  if not found then raise exception 'Item not found' using errcode='P0002'; end if;
  select exists(select 1 from public.stock_ledger where item_id=p_item_id)
    or exists(select 1 from public.purchase_lines where item_id=p_item_id)
    or exists(select 1 from public.office_issue_lines where item_id=p_item_id)
    or exists(select 1 from public.request_lines where item_id=p_item_id)
    or exists(select 1 from public.dispatch_lines where item_id=p_item_id)
    into has_history;
  if has_history then
    update public.items set active=false where id=p_item_id;
    perform public.app_write_audit('item.deactivate','Item',p_item_id::text,to_jsonb(i),jsonb_build_object('active',false));
    return jsonb_build_object('id',p_item_id,'deleted',false,'active',false);
  end if;
  delete from public.items where id=p_item_id;
  return jsonb_build_object('id',p_item_id,'deleted',true);
end
$$;

create or replace function public.delete_supplier(p_supplier_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare s public.suppliers%rowtype; has_history boolean;
begin
  if not public.app_has_permission('suppliers.manage') or public.app_is_branch_side() then raise exception 'Not allowed to delete suppliers' using errcode='42501'; end if;
  select * into s from public.suppliers where id=p_supplier_id for update;
  if not found then raise exception 'Supplier not found' using errcode='P0002'; end if;
  select exists(select 1 from public.purchases where supplier_id=p_supplier_id) into has_history;
  if has_history then
    update public.suppliers set active=false where id=p_supplier_id;
    return jsonb_build_object('id',p_supplier_id,'deleted',false,'active',false);
  end if;
  delete from public.suppliers where id=p_supplier_id;
  return jsonb_build_object('id',p_supplier_id,'deleted',true);
end
$$;

create or replace function public.clear_audit_logs(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare removed bigint;
begin
  if not public.app_is_super_admin() then raise exception 'Not allowed to clear audit logs' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Choose a valid date range' using errcode='22023'; end if;
  delete from public.audit_logs where created_at>=p_from::timestamptz and created_at<(p_to+1)::timestamptz;
  get diagnostics removed=row_count;
  perform public.app_write_audit('audit.clear_range','AuditLog','',null,jsonb_build_object('from',p_from,'to',p_to,'deleted_count',removed));
  return jsonb_build_object('deleted_count',removed);
end
$$;

create or replace function public.prune_stock_ledger()
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare cutoff timestamptz:=now()-interval '30 days'; deleted_count bigint:=0; opening_count bigint:=0; lock_until timestamptz;
begin
  if not public.app_is_super_admin() then raise exception 'Not allowed to run stock retention' using errcode='42501'; end if;
  select stock_retention_lock_until into lock_until from public.app_settings where id=1 for update;
  if lock_until is not null and lock_until>now() then return jsonb_build_object('skipped',true,'deleted_count',0,'opening_balance_count',0); end if;
  update public.app_settings set stock_retention_lock_until=now()+interval '1 hour' where id=1;
  insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,reason,note,created_by)
  select item_id,branch_id,in_transit,sum(quantity_change)::integer,'opening_balance','StockRetention','retention_baseline',
    'Net balance retained after 30-day movement cleanup',auth.uid()
  from public.stock_ledger where created_at<cutoff group by item_id,branch_id,in_transit
  having sum(quantity_change)<>0;
  get diagnostics opening_count=row_count;
  delete from public.stock_ledger where created_at<cutoff;
  get diagnostics deleted_count=row_count;
  update public.app_settings set stock_retention_lock_until=null where id=1;
  perform public.app_write_audit('stock.retention_cleanup','StockLedger','',null,
    jsonb_build_object('cutoff',cutoff,'deleted_count',deleted_count,'opening_balance_count',opening_count));
  return jsonb_build_object('cutoff',cutoff,'deleted_count',deleted_count,'opening_balance_count',opening_count,'skipped',false);
end
$$;

revoke all on function public.update_purchase(bigint,bigint,date,text,text,jsonb) from public,anon;
revoke all on function public.app_sync_auth_profile() from public,anon,authenticated;
revoke all on function public.app_validate_branch() from public,anon,authenticated;
revoke all on function public.app_validate_role_delete() from public,anon,authenticated;
revoke all on function public.delete_item(bigint) from public,anon;
revoke all on function public.delete_supplier(bigint) from public,anon;
revoke all on function public.clear_audit_logs(date,date) from public,anon;
revoke all on function public.prune_stock_ledger() from public,anon;
grant execute on function public.update_purchase(bigint,bigint,date,text,text,jsonb) to authenticated;
grant execute on function public.delete_item(bigint) to authenticated;
grant execute on function public.delete_supplier(bigint) to authenticated;
grant execute on function public.clear_audit_logs(date,date) to authenticated;
grant execute on function public.prune_stock_ledger() to authenticated;

commit;

