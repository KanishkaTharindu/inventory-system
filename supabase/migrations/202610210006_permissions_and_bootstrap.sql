-- Finish table-only access, function grants, and safe one-time bootstrap.
begin;

create or replace function public.create_item(p_code text,p_name text,p_category_id bigint,p_unit text,p_min_stock integer)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare uid uuid:=auth.uid(); item_id bigint; item_code text;
begin
  if uid is null or not public.app_has_permission('items.manage') then raise exception 'Not allowed to create items' using errcode='42501'; end if;
  if btrim(coalesce(p_name,''))='' or btrim(coalesce(p_unit,''))='' or p_min_stock<0 or not exists(select 1 from public.categories where id=p_category_id) then
    raise exception 'Enter a valid item name, category, unit, and minimum stock' using errcode='22023';
  end if;
  item_code:=upper(btrim(coalesce(p_code,'')));
  if item_code='' then item_code:=public.app_next_number('ITM',false); end if;
  insert into public.items(code,name,category_id,unit,min_stock) values(item_code,left(p_name,160),p_category_id,left(p_unit,30),p_min_stock) returning id into item_id;
  return jsonb_build_object('id',item_id,'code',item_code);
end
$$;

create or replace function public.app_protect_item_code()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  new.code:=upper(btrim(new.code));
  if new.code is distinct from old.code and (
    exists(select 1 from public.stock_ledger where item_id=old.id) or
    exists(select 1 from public.purchase_lines where item_id=old.id) or
    exists(select 1 from public.office_issue_lines where item_id=old.id) or
    exists(select 1 from public.request_lines where item_id=old.id) or
    exists(select 1 from public.dispatch_lines where item_id=old.id)
  ) then raise exception 'Item code is locked after the item has history' using errcode='23514'; end if;
  return new;
end
$$;
drop trigger if exists protect_item_code on public.items;
create trigger protect_item_code before update of code on public.items for each row execute function public.app_protect_item_code();

grant execute on function public.create_item(text,text,bigint,text,integer) to authenticated;
grant execute on function public.create_purchase(bigint,date,text,text,jsonb) to authenticated;
grant execute on function public.cancel_purchase(bigint) to authenticated;
grant execute on function public.receive_purchase(bigint,jsonb) to authenticated;
grant execute on function public.create_stock_adjustment(bigint,bigint,text,integer,text,text) to authenticated;
grant execute on function public.create_office_issue(bigint,text,text,date,text,jsonb) to authenticated;
grant execute on function public.cancel_office_issue(bigint,text) to authenticated;
grant execute on function public.create_branch_request(text,jsonb) to authenticated;
grant execute on function public.review_branch_request(bigint,jsonb,boolean) to authenticated;
grant execute on function public.create_dispatch(bigint,date,bigint,jsonb) to authenticated;
grant execute on function public.receive_dispatch(bigint,jsonb) to authenticated;
grant execute on function public.close_dispatch(bigint,text,text) to authenticated;
grant execute on function public.create_petty_cash_request(numeric,text) to authenticated;
grant execute on function public.cancel_petty_cash_request(bigint) to authenticated;
grant execute on function public.review_petty_cash_request(bigint,boolean,numeric,text) to authenticated;
grant execute on function public.record_petty_cash_expense(numeric,text,date) to authenticated;
grant execute on function public.reverse_petty_cash_expense(bigint) to authenticated;
grant execute on function public.set_petty_cash_low_level(numeric) to authenticated;

commit;
