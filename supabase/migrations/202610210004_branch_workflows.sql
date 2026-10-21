-- Branch requests and transfers. Item locks and writes are in one transaction per RPC.
begin;

create or replace function public.create_branch_request(p_notes text,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); profile_row public.profiles%rowtype; req_id bigint; req_no text; line jsonb; item_key bigint; qty integer;
begin
  if uid is null or not public.app_has_permission('requests.create') or not public.app_is_branch_side() or not public.app_branch_module_enabled() then raise exception 'Not allowed to create branch requests' using errcode='42501'; end if;
  select * into profile_row from public.profiles where id=uid and active;
  if profile_row.branch_id is null or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Choose items and quantities for this request' using errcode='22023'; end if;
  req_no:=public.app_next_number('REQ',true);
  insert into public.requests(number,branch_id,notes,requested_by) values(req_no,profile_row.branch_id,left(coalesce(p_notes,''),300),uid) returning id into req_id;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity')::integer;
    if qty<=0 or not exists(select 1 from public.items where id=item_key and active) then raise exception 'A request line has an invalid item or quantity' using errcode='22023'; end if;
    insert into public.request_lines(request_id,item_id,quantity_requested) values(req_id,item_key,qty);
  end loop;
  perform public.app_write_audit('request.create','Request',req_id::text,null,jsonb_build_object('number',req_no));
  return jsonb_build_object('id',req_id,'number',req_no);
end
$$;

create or replace function public.review_branch_request(p_request_id bigint,p_decisions jsonb,p_reject boolean default false)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); req public.requests%rowtype; line jsonb; req_line public.request_lines%rowtype; approved integer; any_yes boolean:=false; any_no boolean:=false; final_status text; seen_ids bigint[]:=array[]::bigint[];
begin
  if uid is null or not public.app_has_permission('requests.review') or public.app_is_branch_side() or not public.app_branch_module_enabled() then raise exception 'Not allowed to review requests' using errcode='42501'; end if;
  select * into req from public.requests where id=p_request_id for update;
  if not found or req.status<>'submitted' then raise exception 'Request is no longer awaiting review' using errcode='23514'; end if;
  if p_reject then
    update public.requests set status='rejected',reviewed_by=uid,reviewed_at=now() where id=p_request_id;
    perform public.app_write_audit('request.review','Request',p_request_id::text,null,jsonb_build_object('status','rejected'));
    return jsonb_build_object('id',p_request_id,'status','rejected');
  end if;
  if jsonb_typeof(p_decisions) is distinct from 'array' then raise exception 'Provide the approved quantity for each line' using errcode='22023'; end if;
  for line in select value from jsonb_array_elements(p_decisions) loop
    if (line->>'line_id')::bigint=any(seen_ids) then raise exception 'Review each request line exactly once' using errcode='22023'; end if;
    seen_ids:=array_append(seen_ids,(line->>'line_id')::bigint);
    select * into req_line from public.request_lines where id=(line->>'line_id')::bigint and request_id=p_request_id for update;
    if not found then raise exception 'Request line not found' using errcode='P0002'; end if;
    approved:=(line->>'quantity_approved')::integer;
    if approved<0 or approved>req_line.quantity_requested then raise exception 'Approved quantity must be between zero and requested quantity' using errcode='23514'; end if;
    update public.request_lines set quantity_approved=approved,reason=left(coalesce(line->>'reason',''),200) where id=req_line.id;
    any_yes:=any_yes or approved>0; any_no:=any_no or approved<req_line.quantity_requested;
  end loop;
  if (select count(*) from public.request_lines where request_id=p_request_id)<>jsonb_array_length(p_decisions) then raise exception 'Review every request line exactly once' using errcode='22023'; end if;
  final_status:=case when not any_yes then 'rejected' when any_no then 'partly_approved' else 'approved' end;
  update public.requests set status=final_status,reviewed_by=uid,reviewed_at=now() where id=p_request_id;
  perform public.app_write_audit('request.review','Request',p_request_id::text,null,jsonb_build_object('status',final_status));
  return jsonb_build_object('id',p_request_id,'status',final_status);
end
$$;

create or replace function public.create_dispatch(p_destination_id bigint,p_dispatch_date date,p_request_id bigint,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); main_id bigint; dispatch_id bigint; ref_no text; line jsonb; item_key bigint; qty integer; balance integer; req_line public.request_lines%rowtype;
begin
  if uid is null or not public.app_has_permission('dispatches.manage') or public.app_is_branch_side() or not public.app_branch_module_enabled() then raise exception 'Not allowed to dispatch stock' using errcode='42501'; end if;
  select id into main_id from public.branches where type='main' and active limit 1;
  if main_id is null then raise exception 'Create an active main office branch first' using errcode='22023'; end if;
  if p_destination_id is null or p_destination_id=main_id or not exists(select 1 from public.branches where id=p_destination_id and active) then raise exception 'Choose an active destination branch' using errcode='22023'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Add at least one dispatch line' using errcode='22023'; end if;
  if p_request_id is not null and not exists(select 1 from public.requests where id=p_request_id and branch_id=p_destination_id and status in ('approved','partly_approved')) then raise exception 'The request is not approved for this branch' using errcode='23514'; end if;
  for item_key in select distinct (value->>'item_id')::bigint from jsonb_array_elements(p_lines) order by 1 loop
    perform 1 from public.items where id=item_key and active for update;
    if not found then raise exception 'A dispatch line contains an inactive item' using errcode='22023'; end if;
  end loop;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity')::integer;
    if qty<=0 or (select count(*) from jsonb_array_elements(p_lines) x where (x->>'item_id')::bigint=item_key)>1 then raise exception 'Use a positive quantity and only one line per item' using errcode='22023'; end if;
    select coalesce(sum(quantity_change),0)::integer into balance from public.stock_ledger where item_id=item_key and branch_id=main_id;
    if balance<qty then raise exception 'There is not enough stock for item %',item_key using errcode='23514'; end if;
    if p_request_id is not null then
      select * into req_line from public.request_lines where request_id=p_request_id and item_id=item_key for update;
      if not found or req_line.quantity_dispatched+qty>req_line.quantity_approved then raise exception 'Dispatch quantity exceeds the approved request' using errcode='23514'; end if;
    end if;
  end loop;
  ref_no:=public.app_next_number('DSP',true);
  insert into public.dispatches(reference,request_id,destination_id,dispatch_date,dispatched_by)
    values(ref_no,p_request_id,p_destination_id,p_dispatch_date,uid) returning id into dispatch_id;
  for line in select value from jsonb_array_elements(p_lines) loop
    item_key:=(line->>'item_id')::bigint; qty:=(line->>'quantity')::integer;
    insert into public.dispatch_lines(dispatch_id,item_id,quantity_sent) values(dispatch_id,item_key,qty);
    insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,created_by)
      values(item_key,main_id,false,-qty,'dispatch_out','Dispatch',dispatch_id::text,uid);
    insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,created_by)
      values(item_key,null,true,qty,'dispatch_out','Dispatch',dispatch_id::text,uid);
    if p_request_id is not null then update public.request_lines set quantity_dispatched=quantity_dispatched+qty where request_id=p_request_id and item_id=item_key; end if;
  end loop;
  if p_request_id is not null and not exists(select 1 from public.request_lines where request_id=p_request_id and quantity_dispatched<quantity_approved) then update public.requests set status='completed' where id=p_request_id; end if;
  perform public.app_write_audit('dispatch.create','Dispatch',dispatch_id::text,null,jsonb_build_object('reference',ref_no,'destination',p_destination_id));
  return jsonb_build_object('id',dispatch_id,'reference',ref_no);
end
$$;

create or replace function public.receive_dispatch(p_dispatch_id bigint,p_receipts jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); profile_row public.profiles%rowtype; d public.dispatches%rowtype; line jsonb; dl public.dispatch_lines%rowtype; qty_received integer; qty_damaged integer; qty_short integer; differences boolean:=false; seen_ids bigint[]:=array[]::bigint[];
begin
  if uid is null or not public.app_has_permission('dispatches.receive') or not public.app_is_branch_side() or not public.app_branch_module_enabled() then raise exception 'Not allowed to receive dispatches' using errcode='42501'; end if;
  select * into profile_row from public.profiles where id=uid and active;
  select * into d from public.dispatches where id=p_dispatch_id for update;
  if not found or d.destination_id<>profile_row.branch_id then raise exception 'Dispatch not found' using errcode='P0002'; end if;
  if d.status<>'in_transit' or jsonb_typeof(p_receipts) is distinct from 'array' then raise exception 'This dispatch cannot be received' using errcode='23514'; end if;
  for line in select value from jsonb_array_elements(p_receipts) loop
    if (line->>'line_id')::bigint=any(seen_ids) then raise exception 'Confirm each dispatch line exactly once' using errcode='22023'; end if;
    seen_ids:=array_append(seen_ids,(line->>'line_id')::bigint);
    select * into dl from public.dispatch_lines where id=(line->>'line_id')::bigint and dispatch_id=p_dispatch_id for update;
    if not found then raise exception 'Dispatch line not found' using errcode='P0002'; end if;
    qty_received:=(line->>'received')::integer; qty_damaged:=(line->>'damaged')::integer; qty_short:=dl.quantity_sent-qty_received-qty_damaged;
    if qty_received<0 or qty_damaged<0 or qty_short<0 then raise exception 'Received and damaged amounts cannot exceed the sent quantity' using errcode='23514'; end if;
    differences:=differences or qty_damaged>0 or qty_short>0;
    update public.dispatch_lines set quantity_received=qty_received,quantity_damaged=qty_damaged,quantity_short=qty_short,note=left(coalesce(line->>'note',''),200) where id=dl.id;
    if qty_received>0 then
      insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,created_by)
        values(dl.item_id,null,true,-qty_received,'branch_receipt','Dispatch',p_dispatch_id::text,uid);
      insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,created_by)
        values(dl.item_id,d.destination_id,false,qty_received,'branch_receipt','Dispatch',p_dispatch_id::text,uid);
    end if;
  end loop;
  if (select count(*) from public.dispatch_lines where dispatch_id=p_dispatch_id)<>jsonb_array_length(p_receipts) then raise exception 'Confirm every dispatch line exactly once' using errcode='22023'; end if;
  update public.dispatches set status=case when differences then 'received_with_differences' else 'received' end,received_by=uid,received_at=now() where id=p_dispatch_id;
  perform public.app_write_audit('dispatch.receive','Dispatch',p_dispatch_id::text,null,p_receipts);
  return jsonb_build_object('id',p_dispatch_id,'status',case when differences then 'received_with_differences' else 'received' end);
end
$$;

create or replace function public.close_dispatch(p_dispatch_id bigint,p_resolution text,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); d public.dispatches%rowtype; dl public.dispatch_lines%rowtype; leftover integer; main_id bigint;
begin
  if uid is null or not public.app_has_permission('dispatches.manage') or public.app_is_branch_side() or not public.app_branch_module_enabled() then raise exception 'Not allowed to close dispatches' using errcode='42501'; end if;
  if p_resolution not in ('write_off','return_to_main') then raise exception 'Choose a valid dispatch resolution' using errcode='22023'; end if;
  select * into d from public.dispatches where id=p_dispatch_id for update;
  if not found or d.status not in ('received','received_with_differences') then raise exception 'Dispatch cannot be closed yet' using errcode='23514'; end if;
  select id into main_id from public.branches where type='main' and active limit 1;
  if p_resolution='return_to_main' and main_id is null then raise exception 'Create an active main office branch first' using errcode='22023'; end if;
  for dl in select * from public.dispatch_lines where dispatch_id=p_dispatch_id for update loop
    leftover:=dl.quantity_damaged+dl.quantity_short;
    if leftover>0 then
      insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,reason,note,created_by)
        values(dl.item_id,null,true,-leftover,'adjustment','Dispatch',p_dispatch_id::text,'other',left(coalesce(p_note,'Settled at dispatch close'),200),uid);
      if p_resolution='return_to_main' then
        insert into public.stock_ledger(item_id,branch_id,in_transit,quantity_change,type,source_model,source_id,reason,note,created_by)
          values(dl.item_id,main_id,false,leftover,'adjustment','Dispatch',p_dispatch_id::text,'other',left(coalesce(p_note,'Returned to main office'),200),uid);
      end if;
    end if;
  end loop;
  update public.dispatches set status='closed' where id=p_dispatch_id;
  perform public.app_write_audit('dispatch.close','Dispatch',p_dispatch_id::text,null,jsonb_build_object('resolution',p_resolution,'note',left(coalesce(p_note,''),200)));
  return jsonb_build_object('id',p_dispatch_id,'status','closed');
end
$$;

commit;
