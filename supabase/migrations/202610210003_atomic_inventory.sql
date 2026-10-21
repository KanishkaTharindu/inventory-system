-- Transactional inventory and branch workflows. All writes verify auth.uid() and permissions here.
begin;

create or replace function public.create_purchase(p_supplier_id bigint,p_purchase_date date,p_invoice_ref text,p_notes text,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); new_id bigint; purchase_no text; line jsonb; item_key bigint; qty integer; cost numeric;
begin
  if uid is null or not public.app_has_permission('purchases.manage') or public.app_is_branch_side() then raise exception 'Not allowed to create purchases' using errcode='42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one purchase line' using errcode='22023'; end if;
  if not exists(select 1 from public.suppliers where id=p_supplier_id and active) then raise exception 'Choose an active supplier' using errcode='22023'; end if;
  purchase_no:=public.app_next_number('PUR',true);
  insert into public.purchases(number,supplier_id,purchase_date,invoice_ref,notes,branch_id,created_by)
  values(purchase_no,p_supplier_id,p_purchase_date,left(coalesce(p_invoice_ref,''),80),left(coalesce(p_notes,''),500),
         (select id from public.branches where type='main' and active limit 1),uid) returning id into new_id;
  if (select branch_id from public.purchases where id=new_id) is null then raise exception 'Create an active main office branch first' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity_ordered')::integer; cost:=(line->>'unit_cost')::numeric;
    if qty<=0 or cost<0 or not exists(select 1 from public.items where id=item_key and active) then raise exception 'Purchase line has an invalid item, quantity, or cost' using errcode='22023'; end if;
    insert into public.purchase_lines(purchase_id,item_id,quantity_ordered,unit_cost) values(new_id,item_key,qty,cost);
  end loop;
  perform public.app_write_audit('purchase.create','Purchase',new_id::text,null,jsonb_build_object('number',purchase_no));
  return jsonb_build_object('id',new_id,'number',purchase_no);
end
$$;

create or replace function public.cancel_purchase(p_purchase_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.purchases%rowtype;
begin
  if uid is null or not public.app_has_permission('purchases.manage') or public.app_is_branch_side() then raise exception 'Not allowed to cancel purchases' using errcode='42501'; end if;
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found or not public.app_can_access_branch(p.branch_id) then raise exception 'Purchase not found' using errcode='P0002'; end if;
  if p.status<>'ordered' or exists(select 1 from public.purchase_lines where purchase_id=p_purchase_id and quantity_received>0) then raise exception 'A purchase with received goods cannot be cancelled' using errcode='23514'; end if;
  update public.purchases set status='cancelled' where id=p_purchase_id;
  perform public.app_write_audit('purchase.cancel','Purchase',p_purchase_id::text,null,null);
  return jsonb_build_object('id',p_purchase_id,'status','cancelled');
end
$$;

create or replace function public.receive_purchase(p_purchase_id bigint,p_receipts jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.purchases%rowtype; line jsonb; pl public.purchase_lines%rowtype; take_qty integer; full_count bigint; total_count bigint; new_status text;
begin
  if uid is null or not public.app_has_permission('purchases.receive') or public.app_is_branch_side() then raise exception 'Not allowed to receive purchases' using errcode='42501'; end if;
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found or not public.app_can_access_branch(p.branch_id) then raise exception 'Purchase not found' using errcode='P0002'; end if;
  if p.status='cancelled' then raise exception 'A cancelled purchase cannot be received' using errcode='23514'; end if;
  if jsonb_typeof(p_receipts) is distinct from 'array' or jsonb_array_length(p_receipts)=0 then raise exception 'Enter received quantities' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(p_receipts) loop
    select * into pl from public.purchase_lines where id=(line->>'line_id')::bigint and purchase_id=p_purchase_id for update;
    if not found then raise exception 'Purchase line not found' using errcode='P0002'; end if;
    take_qty:=(line->>'quantity')::integer;
    if take_qty<=0 or pl.quantity_received+take_qty>pl.quantity_ordered then raise exception 'Received quantity exceeds the outstanding quantity' using errcode='23514'; end if;
    update public.purchase_lines set quantity_received=quantity_received+take_qty where id=pl.id;
    insert into public.stock_ledger(item_id,branch_id,quantity_change,type,source_model,source_id,created_by)
      values(pl.item_id,p.branch_id,take_qty,'purchase_receipt','Purchase',p_purchase_id::text,uid);
    update public.items set last_unit_cost=pl.unit_cost where id=pl.item_id;
  end loop;
  select count(*) filter(where quantity_received=quantity_ordered),count(*) into full_count,total_count from public.purchase_lines where purchase_id=p_purchase_id;
  new_status:=case when full_count=total_count then 'received'
    when exists(select 1 from public.purchase_lines where purchase_id=p_purchase_id and quantity_received>0) then 'partly_received' else 'ordered' end;
  update public.purchases set status=new_status where id=p_purchase_id;
  perform public.app_write_audit('purchase.receive','Purchase',p_purchase_id::text,null,p_receipts);
  return jsonb_build_object('id',p_purchase_id,'status',new_status);
end
$$;

create or replace function public.create_stock_adjustment(p_branch_id bigint,p_item_id bigint,p_direction text,p_quantity integer,p_reason text,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); delta integer; balance integer; new_balance integer;
begin
  if uid is null or not public.app_has_permission('stock.adjust') or public.app_is_branch_side() then raise exception 'Not allowed to adjust stock' using errcode='42501'; end if;
  if p_quantity<=0 or p_direction not in ('add','remove') or p_reason not in ('count_difference','damaged','expired','found','other') then raise exception 'Enter a valid stock adjustment' using errcode='22023'; end if;
  if p_reason='other' and btrim(coalesce(p_note,''))='' then raise exception 'Add a note for this adjustment' using errcode='22023'; end if;
  if not exists(select 1 from public.branches where id=p_branch_id and active) or not exists(select 1 from public.items where id=p_item_id and active) then raise exception 'Choose an active branch and item' using errcode='22023'; end if;
  perform 1 from public.items where id=p_item_id for update;
  select coalesce(sum(quantity_change),0)::integer into balance from public.stock_ledger where item_id=p_item_id and branch_id=p_branch_id;
  delta:=case when p_direction='add' then p_quantity else -p_quantity end; new_balance:=balance+delta;
  if new_balance<0 then raise exception 'There is not enough stock to remove that quantity' using errcode='23514'; end if;
  insert into public.stock_ledger(item_id,branch_id,quantity_change,type,reason,note,created_by)
    values(p_item_id,p_branch_id,delta,'adjustment',p_reason,left(coalesce(p_note,''),200),uid);
  perform public.app_write_audit('stock.adjust','Item',p_item_id::text,null,jsonb_build_object('branch_id',p_branch_id,'change',delta,'reason',p_reason,'note',left(coalesce(p_note,''),200)));
  return jsonb_build_object('balance',new_balance);
end
$$;

create or replace function public.create_office_issue(p_branch_id bigint,p_recipient text,p_department text,p_issue_date date,p_purpose text,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); issue_id bigint; issue_no text; line jsonb; item_key bigint; qty integer; balance integer;
begin
  if uid is null or not public.app_has_permission('issues.manage') or public.app_is_branch_side() then raise exception 'Not allowed to issue stock' using errcode='42501'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one issue line' using errcode='22023'; end if;
  if p_branch_id is null then select id into p_branch_id from public.branches where type='main' and active limit 1; end if;
  if p_branch_id is null or not exists(select 1 from public.branches where id=p_branch_id and active) then raise exception 'Choose an active branch' using errcode='22023'; end if;
  for item_key in select distinct (value->>'item_id')::bigint from jsonb_array_elements(p_lines) order by 1 loop
    perform 1 from public.items where id=item_key and active for update;
    if not found then raise exception 'An issue line contains an inactive item' using errcode='22023'; end if;
  end loop;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity')::integer;
    if qty<=0 or (select count(*) from jsonb_array_elements(p_lines) x where (x->>'item_id')::bigint=item_key)>1 then raise exception 'Use a positive quantity and only one line per item' using errcode='22023'; end if;
    select coalesce(sum(quantity_change),0)::integer into balance from public.stock_ledger where item_id=item_key and branch_id=p_branch_id;
    if balance<qty then raise exception 'There is not enough stock for item %',item_key using errcode='23514'; end if;
  end loop;
  issue_no:=public.app_next_number('ISS',true);
  insert into public.office_issues(number,recipient,department,issue_date,branch_id,purpose,issued_by)
    values(issue_no,left(p_recipient,120),left(coalesce(p_department,''),120),p_issue_date,p_branch_id,left(coalesce(p_purpose,''),300),uid) returning id into issue_id;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity')::integer;
    insert into public.office_issue_lines(issue_id,item_id,quantity) values(issue_id,item_key,qty);
    insert into public.stock_ledger(item_id,branch_id,quantity_change,type,source_model,source_id,created_by)
      values(item_key,p_branch_id,-qty,'office_issue','OfficeIssue',issue_id::text,uid);
  end loop;
  perform public.app_write_audit('issue.create','OfficeIssue',issue_id::text,null,jsonb_build_object('number',issue_no));
  return jsonb_build_object('id',issue_id,'number',issue_no);
end
$$;

create or replace function public.cancel_office_issue(p_issue_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); issue_row public.office_issues%rowtype; old_row record;
begin
  if uid is null or not public.app_has_permission('issues.manage') or public.app_is_branch_side() then raise exception 'Not allowed to cancel issues' using errcode='42501'; end if;
  select * into issue_row from public.office_issues where id=p_issue_id for update;
  if not found or not public.app_can_access_branch(issue_row.branch_id) then raise exception 'Issue not found' using errcode='P0002'; end if;
  if issue_row.status<>'issued' then raise exception 'This issue has already been cancelled' using errcode='23514'; end if;
  for old_row in select item_id,quantity from public.office_issue_lines where issue_id=p_issue_id loop
    insert into public.stock_ledger(item_id,branch_id,quantity_change,type,source_model,source_id,reason,note,reversal_of,created_by)
      select old_row.item_id,issue_row.branch_id,old_row.quantity,'reversal','OfficeIssue',p_issue_id::text,'other',left(coalesce(p_reason,''),200),s.id,uid
      from public.stock_ledger s where s.source_model='OfficeIssue' and s.source_id=p_issue_id::text and s.item_id=old_row.item_id and s.type='office_issue' limit 1;
  end loop;
  update public.office_issues set status='cancelled',cancelled_by=uid,cancelled_at=now(),cancel_reason=left(coalesce(p_reason,''),200) where id=p_issue_id;
  perform public.app_write_audit('issue.cancel','OfficeIssue',p_issue_id::text,null,jsonb_build_object('reason',left(coalesce(p_reason,''),200)));
  return jsonb_build_object('id',p_issue_id,'status','cancelled');
end
$$;

commit;
