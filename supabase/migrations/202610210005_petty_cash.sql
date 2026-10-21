-- Petty cash operations are transactional and append-only.
begin;

create or replace function public.create_petty_cash_request(p_amount numeric,p_purpose text default '')
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.profiles%rowtype; req_id bigint; req_no text;
begin
  if uid is null or not public.app_has_permission('petty_cash.request') then raise exception 'Not allowed to request petty cash' using errcode='42501'; end if;
  select * into p from public.profiles where id=uid and active;
  if p.branch_id is null or p_amount<=0 then raise exception 'Enter a positive amount and assign an office branch' using errcode='22023'; end if;
  req_no:=public.app_next_number('PCR',true);
  insert into public.petty_cash_requests(number,branch_id,amount_requested,purpose,requested_by)
    values(req_no,p.branch_id,p_amount,left(coalesce(p_purpose,''),300),uid) returning id into req_id;
  perform public.app_write_audit('petty_cash.create','PettyCashRequest',req_id::text,null,jsonb_build_object('number',req_no,'amount',p_amount));
  return jsonb_build_object('id',req_id,'number',req_no);
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

create or replace function public.review_petty_cash_request(p_request_id bigint,p_approve boolean,p_amount numeric default null,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); req public.petty_cash_requests%rowtype; approved numeric; new_status text;
begin
  if uid is null or not public.app_has_permission('petty_cash.approve') or public.app_is_branch_side() then raise exception 'Not allowed to review petty cash requests' using errcode='42501'; end if;
  select * into req from public.petty_cash_requests where id=p_request_id for update;
  if not found or not public.app_can_access_branch(req.branch_id) or req.status<>'submitted' then raise exception 'Request is no longer pending review' using errcode='23514'; end if;
  if req.requested_by=uid and not public.app_is_super_admin() then raise exception 'You cannot approve your own request' using errcode='42501'; end if;
  new_status:=case when p_approve then 'approved' else 'rejected' end;
  approved:=case when p_approve then coalesce(p_amount,req.amount_requested) else 0 end;
  if approved<0 or approved>req.amount_requested then raise exception 'Approved amount must not exceed the request' using errcode='23514'; end if;
  if p_approve and approved=0 then raise exception 'Approved amount must be greater than zero' using errcode='22023'; end if;
  update public.petty_cash_requests set status=new_status,amount_approved=approved,review_note=left(coalesce(p_note,''),200),reviewed_by=uid,reviewed_at=now() where id=p_request_id;
  if p_approve then
    insert into public.petty_cash_entries(branch_id,type,amount,description,entry_date,request_id,created_by)
      values(req.branch_id,'top_up',approved,'Petty cash '||req.number,current_date,p_request_id,uid);
  end if;
  perform public.app_write_audit('petty_cash.review','PettyCashRequest',p_request_id::text,null,jsonb_build_object('status',new_status,'amount',approved));
  return jsonb_build_object('id',p_request_id,'status',new_status,'amount_approved',approved);
end
$$;

create or replace function public.record_petty_cash_expense(p_amount numeric,p_description text,p_entry_date date default current_date)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); p public.profiles%rowtype; balance numeric; entry_id bigint;
begin
  if uid is null or not public.app_has_permission('petty_cash.request') then raise exception 'Not allowed to record spending' using errcode='42501'; end if;
  select * into p from public.profiles where id=uid and active;
  if p.branch_id is null or p_amount<=0 then raise exception 'Enter a positive amount' using errcode='22023'; end if;
  perform 1 from public.branches where id=p.branch_id for update;
  select coalesce(sum(amount),0) into balance from public.petty_cash_entries where branch_id=p.branch_id;
  if p_amount>balance then raise exception 'The expense exceeds the available balance' using errcode='23514'; end if;
  insert into public.petty_cash_entries(branch_id,type,amount,description,entry_date,created_by)
    values(p.branch_id,'expense',-p_amount,left(coalesce(p_description,''),300),coalesce(p_entry_date,current_date),uid) returning id into entry_id;
  perform public.app_write_audit('petty_cash.expense','PettyCashEntry',entry_id::text,null,jsonb_build_object('amount',p_amount));
  return jsonb_build_object('id',entry_id,'balance',balance-p_amount);
end
$$;

create or replace function public.reverse_petty_cash_expense(p_entry_id bigint)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); e public.petty_cash_entries%rowtype; reversal_id bigint;
begin
  select * into e from public.petty_cash_entries where id=p_entry_id for update;
  if not found or e.type<>'expense' then raise exception 'Expense not found' using errcode='P0002'; end if;
  if not public.app_can_access_branch(e.branch_id) or
     (e.branch_id<>(select branch_id from public.profiles where id=uid) and not public.app_has_permission('petty_cash.approve')) then
    raise exception 'Not allowed to reverse this expense' using errcode='42501';
  end if;
  if exists(select 1 from public.petty_cash_entries where reversal_of=p_entry_id) then raise exception 'Expense already reversed' using errcode='23514'; end if;
  insert into public.petty_cash_entries(branch_id,type,amount,description,entry_date,reversal_of,created_by)
    values(e.branch_id,'reversal',-e.amount,left('Cancelled: '||e.description,300),current_date,p_entry_id,uid) returning id into reversal_id;
  perform public.app_write_audit('petty_cash.cancel_expense','PettyCashEntry',p_entry_id::text,null,jsonb_build_object('reversal_id',reversal_id));
  return jsonb_build_object('id',reversal_id);
end
$$;

create or replace function public.set_petty_cash_low_level(p_level numeric)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.app_has_permission('petty_cash.configure') or p_level<0 then raise exception 'Not allowed or invalid low level' using errcode='42501'; end if;
  update public.app_settings set petty_cash_low_level=p_level where id=1;
  perform public.app_write_audit('petty_cash.set_low_level','Setting','1',null,jsonb_build_object('level',p_level));
  return jsonb_build_object('petty_cash_low_level',p_level);
end
$$;

commit;
