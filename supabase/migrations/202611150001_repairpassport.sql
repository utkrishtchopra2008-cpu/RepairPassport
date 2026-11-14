-- Additive MVP migration. Never reset a linked database. Stop on name collisions.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$ begin
 if (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto')<>'extensions' then
  raise exception 'pgcrypto exists outside extensions; inspect existing configuration before applying this migration';
 end if;
end $$;
create schema rp_private;
revoke all on schema rp_private from public, anon, authenticated;

create table public.appliances (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete restrict,
 created_by uuid not null references auth.users(id) on delete restrict,
 brand text not null check (length(trim(brand)) between 1 and 100),
 model text not null check (length(trim(model)) between 1 and 100),
 category text not null default 'washing_machine' check(category='washing_machine'),
 nickname text check(length(nickname)<=120), serial_number text check(length(serial_number)<=120),
 purchase_date date, warranty_until date,
 created_at timestamptz not null default now(), support_lookup_at timestamptz
);
create table public.service_events (
 id uuid primary key default gen_random_uuid(),
 appliance_id uuid not null references public.appliances(id) on delete restrict,
 author_id uuid not null references auth.users(id) on delete restrict,
 event_type text not null check(event_type in ('repair','maintenance','correction','transfer')),
 title text not null check(length(trim(title)) between 1 and 160),
 description text check(length(description)<=2000), occurred_on date not null,
 cost_minor bigint check(cost_minor between 0 and 100000000),
 currency text not null default 'INR' check(currency='INR'),
 corrects_event_id uuid unique references public.service_events(id) on delete restrict,
 attribution text not null default 'owner_reported' check(attribution='owner_reported'),
 created_at timestamptz not null default now(),
 check ((event_type='correction') = (corrects_event_id is not null))
);
create table public.documents (
 id uuid primary key default gen_random_uuid(),
 appliance_id uuid not null references public.appliances(id) on delete restrict,
 uploaded_by uuid not null references auth.users(id) on delete restrict,
 kind text not null check(kind in ('invoice','photo')),
 object_path text not null unique,
 content_type text not null check(content_type in ('application/pdf','image/jpeg','image/png','image/webp')),
 byte_size integer not null check(byte_size between 1 and 10485760),
 created_at timestamptz not null default now()
);
create table public.repair_requests (
 id uuid primary key default gen_random_uuid(),
 appliance_id uuid not null references public.appliances(id) on delete restrict,
 author_id uuid not null references auth.users(id) on delete restrict,
 symptoms text not null check(length(trim(symptoms)) between 1 and 2000),
 error_code text check(length(error_code)<=120),
 status text not null default 'open' check(status in ('open','closed')),
 created_at timestamptz not null default now()
);
create table public.quotes (
 id uuid primary key default gen_random_uuid(),
 repair_request_id uuid not null references public.repair_requests(id) on delete restrict,
 author_id uuid not null references auth.users(id) on delete restrict,
 provider_label text check(length(provider_label)<=160),
 part_description text check(length(part_description)<=160),
 parts_cost_minor bigint check(parts_cost_minor between 0 and 100000000),
 labor_cost_minor bigint check(labor_cost_minor between 0 and 100000000),
 visit_cost_minor bigint check(visit_cost_minor between 0 and 100000000),
 tax_cost_minor bigint check(tax_cost_minor between 0 and 100000000),
 total_cost_minor bigint check(total_cost_minor between 0 and 100000000),
 warranty_days integer check(warranty_days between 0 and 3650),
 exclusions text check(length(exclusions)<=2000),
 currency text not null default 'INR' check(currency='INR'),
 status text not null default 'recorded' check(status='recorded'),
 created_at timestamptz not null default now()
);
create table public.share_links (
 id uuid primary key default gen_random_uuid(),
 appliance_id uuid not null references public.appliances(id) on delete restrict,
 created_by uuid not null references auth.users(id) on delete restrict,
 token_hash text not null unique, expires_at timestamptz not null, revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.transfers (
 id uuid primary key default gen_random_uuid(),
 appliance_id uuid not null references public.appliances(id) on delete restrict,
 from_owner_id uuid not null references auth.users(id) on delete restrict,
 recipient_email text not null check(length(recipient_email)<=254),
 token_hash text not null unique,
 status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 expires_at timestamptz not null,
 accepted_by uuid references auth.users(id) on delete restrict, accepted_at timestamptz,
 created_at timestamptz not null default now(),
 check((status='accepted') = (accepted_by is not null and accepted_at is not null))
);
create index on public.appliances(owner_id);
create index on public.service_events(appliance_id,occurred_on,created_at);
create index on public.documents(appliance_id,uploaded_by);
create index on public.repair_requests(appliance_id,author_id);
create index on public.quotes(repair_request_id);
create index on public.share_links(appliance_id);
create index on public.transfers(appliance_id);
create unique index one_pending_transfer on public.transfers(appliance_id) where status='pending';

-- Security-definer helpers live outside exposed schemas and have fixed search paths.
create function rp_private.owns(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.appliances where id=p_id and owner_id=auth.uid());
$$;
create function rp_private.owns_request(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.repair_requests r join public.appliances a on a.id=r.appliance_id
 where r.id=p_id and r.author_id=auth.uid() and a.owner_id=auth.uid());
$$;
revoke all on function rp_private.owns(uuid), rp_private.owns_request(uuid) from public;
grant usage on schema rp_private to authenticated;
grant execute on function rp_private.owns(uuid), rp_private.owns_request(uuid) to authenticated;

alter table public.appliances enable row level security;
alter table public.service_events enable row level security;
alter table public.documents enable row level security;
alter table public.repair_requests enable row level security;
alter table public.quotes enable row level security;
alter table public.share_links enable row level security;
alter table public.transfers enable row level security;
revoke all on public.appliances,public.service_events,public.documents,public.repair_requests,public.quotes,public.share_links,public.transfers from public,anon,authenticated;
grant select on public.appliances,public.service_events,public.documents,public.repair_requests,public.quotes to authenticated;
grant select(id,appliance_id,created_by,expires_at,revoked_at,created_at) on public.share_links to authenticated;
grant select(id,appliance_id,from_owner_id,recipient_email,status,expires_at,accepted_by,accepted_at,created_at) on public.transfers to authenticated;
create policy appliance_read on public.appliances for select to authenticated using(owner_id=(select auth.uid()));
create policy event_read on public.service_events for select to authenticated using(rp_private.owns(appliance_id));
create policy document_read on public.documents for select to authenticated using(uploaded_by=(select auth.uid()) and rp_private.owns(appliance_id));
create policy request_read on public.repair_requests for select to authenticated using(author_id=(select auth.uid()) and rp_private.owns(appliance_id));
create policy quote_read on public.quotes for select to authenticated using(author_id=(select auth.uid()) and rp_private.owns_request(repair_request_id));
create policy share_read on public.share_links for select to authenticated using(created_by=(select auth.uid()) and rp_private.owns(appliance_id));
create policy transfer_read on public.transfers for select to authenticated using(from_owner_id=(select auth.uid()) and rp_private.owns(appliance_id));

-- Append-only even for accidental privileged UPDATE/DELETE (migrations can remove trigger explicitly).
create function rp_private.immutable_event() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='RP403',message='Service events are append-only'; end;
$$;
revoke all on function rp_private.immutable_event() from public;
create trigger immutable_service_event before update or delete on public.service_events for each row execute function rp_private.immutable_event();

-- Validate at the database boundary too: callers can bypass the Edge Function.
create function rp_private.validate_payload(p jsonb, allowed text[], required text[]) returns void
language plpgsql set search_path='' as $$
declare k text;
begin
 if jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>16384 then
  raise exception using errcode='RP400',message='Payload must be an object under 16 KiB';
 end if;
 for k in select jsonb_object_keys(p) loop
  if not(k=any(allowed)) then raise exception using errcode='RP400',message='Unexpected field: '||k; end if;
 end loop;
 if not(p ?& required) then raise exception using errcode='RP400',message='Missing required fields'; end if;
 for k in select jsonb_object_keys(p) loop
  if p->k='null'::jsonb then
   if not(k=any(array['nickname','serial_number','purchase_date','warranty_until','description','cost_minor','corrects_event_id','error_code','provider_label','part_description','parts_cost_minor','labor_cost_minor','visit_cost_minor','tax_cost_minor','total_cost_minor','warranty_days','exclusions'])) then
    raise exception using errcode='RP400',message='Field cannot be null: '||k;
   end if;
   continue;
  end if;
  if k in ('cost_minor','parts_cost_minor','labor_cost_minor','visit_cost_minor','tax_cost_minor','total_cost_minor','warranty_days','byte_size','expires_in_hours') then
   if jsonb_typeof(p->k)<>'number' or (p->>k)!~'^[0-9]+$' then raise exception using errcode='RP400',message='Expected nonnegative integer: '||k; end if;
  elsif jsonb_typeof(p->k)<>'string' then raise exception using errcode='RP400',message='Expected text: '||k;
  end if;
  if k in ('purchase_date','warranty_until','occurred_on') and (p->>k)!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
   raise exception using errcode='RP400',message='Expected ISO date: '||k;
  end if;
  if k in ('appliance_id','repair_request_id','share_link_id','transfer_id','corrects_event_id') and (p->>k)!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   raise exception using errcode='RP400',message='Expected UUID: '||k;
  end if;
 end loop;
end;
$$;
revoke all on function rp_private.validate_payload(jsonb,text[],text[]) from public;

create function public.passport_mutate(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 u uuid:=auth.uid(); p jsonb:=p_payload; a public.appliances; ev public.service_events;
 d public.documents; r public.repair_requests; q public.quotes; s public.share_links; t public.transfers;
 aid uuid; rid uuid; raw_token text; h integer; v_email text; confirmed timestamptz; allowed text[]; required text[];
begin
 if u is null then raise exception using errcode='RP401',message='Sign in required'; end if;
 case p_action
 when 'appliance_create' then allowed:=array['brand','model','nickname','serial_number','purchase_date','warranty_until']; required:=array['brand','model'];
 when 'appliance_update' then allowed:=array['appliance_id','brand','model','nickname','serial_number','purchase_date','warranty_until']; required:=array['appliance_id'];
 when 'event_append' then allowed:=array['appliance_id','event_type','title','description','occurred_on','cost_minor','corrects_event_id']; required:=array['appliance_id','event_type','title','occurred_on'];
 when 'document_create' then allowed:=array['appliance_id','kind','content_type','byte_size']; required:=allowed;
 when 'request_create' then allowed:=array['appliance_id','symptoms','error_code']; required:=array['appliance_id','symptoms'];
 when 'request_close' then allowed:=array['repair_request_id']; required:=allowed;
 when 'quote_create' then allowed:=array['repair_request_id','provider_label','part_description','parts_cost_minor','labor_cost_minor','visit_cost_minor','tax_cost_minor','total_cost_minor','warranty_days','exclusions']; required:=allowed;
 when 'share_create' then allowed:=array['appliance_id','expires_in_hours']; required:=array['appliance_id'];
 when 'share_revoke' then allowed:=array['share_link_id']; required:=allowed;
 when 'transfer_invite' then allowed:=array['appliance_id','recipient_email','expires_in_hours']; required:=array['appliance_id','recipient_email'];
 when 'transfer_revoke' then allowed:=array['transfer_id']; required:=allowed;
 when 'transfer_accept' then allowed:=array['token']; required:=allowed;
 else raise exception using errcode='RP400',message='Unknown action';
 end case;
 perform rp_private.validate_payload(p,allowed,required);
 if p_action='appliance_create' then
  insert into public.appliances(owner_id,created_by,brand,model,nickname,serial_number,purchase_date,warranty_until)
  values(u,u,trim(p->>'brand'),trim(p->>'model'),p->>'nickname',p->>'serial_number',(p->>'purchase_date')::date,(p->>'warranty_until')::date) returning * into a;
  return to_jsonb(a);
 end if;
 -- Resolve resource IDs before locking. Recheck every referenced row AFTER the appliance lock.
 if p ? 'appliance_id' then aid:=(p->>'appliance_id')::uuid;
 elsif p_action in ('quote_create','request_close') then
  rid:=(p->>'repair_request_id')::uuid;
  select appliance_id into aid from public.repair_requests where id=rid;
 elsif p_action='share_revoke' then
  select appliance_id into aid from public.share_links where id=(p->>'share_link_id')::uuid;
 elsif p_action='transfer_revoke' then
  select appliance_id into aid from public.transfers where id=(p->>'transfer_id')::uuid;
 elsif p_action='transfer_accept' then
  if (p->>'token') is null or (p->>'token')!~'^[0-9a-f]{64}$' then raise exception using errcode='RP400',message='Invalid token'; end if;
  select appliance_id into aid from public.transfers where token_hash=encode(extensions.digest(p->>'token','sha256'),'hex');
 end if;
 select * into a from public.appliances where id=aid for update;
 if not found then raise exception using errcode='RP404',message='Record not found'; end if;
 if p_action='transfer_accept' then
  select * into t from public.transfers where appliance_id=a.id and token_hash=encode(extensions.digest(p->>'token','sha256'),'hex') for update;
  select lower(au.email),au.email_confirmed_at into v_email,confirmed from auth.users au where au.id=u;
  if v_email is distinct from t.recipient_email or confirmed is null or u=t.from_owner_id then
   raise exception using errcode='RP403',message='Invitation requires the intended confirmed recipient';
  end if;
  if t.status<>'pending' then raise exception using errcode='RP409',message='Invitation already used or revoked'; end if;
  if t.expires_at<=clock_timestamp() then raise exception using errcode='RP410',message='Invitation expired'; end if;
  if a.owner_id<>t.from_owner_id then raise exception using errcode='RP409',message='Ownership changed'; end if;
  update public.appliances set owner_id=u where id=a.id;
  update public.transfers set status='accepted',accepted_by=u,accepted_at=clock_timestamp() where id=t.id returning * into t;
  update public.transfers set status='revoked' where appliance_id=a.id and id<>t.id and status='pending';
  update public.share_links set revoked_at=coalesce(revoked_at,clock_timestamp()) where appliance_id=a.id;
  insert into public.service_events(appliance_id,author_id,event_type,title,occurred_on)
   values(a.id,u,'transfer','Passport transferred',(clock_timestamp() at time zone 'UTC')::date);
  return jsonb_build_object('id',t.id,'appliance_id',a.id,'status','accepted','accepted_at',t.accepted_at);
 end if;
 if a.owner_id<>u then raise exception using errcode='RP404',message='Record not found'; end if;
 case p_action
 when 'appliance_update' then
  update public.appliances set
   brand=case when p?'brand' then trim(p->>'brand') else brand end,
   model=case when p?'model' then trim(p->>'model') else model end,
   nickname=case when p?'nickname' then p->>'nickname' else nickname end,
   serial_number=case when p?'serial_number' then p->>'serial_number' else serial_number end,
   purchase_date=case when p?'purchase_date' then (p->>'purchase_date')::date else purchase_date end,
   warranty_until=case when p?'warranty_until' then (p->>'warranty_until')::date else warranty_until end
   where id=a.id returning * into a;
  return to_jsonb(a);
 when 'event_append' then
  if p->>'event_type' not in ('repair','maintenance','correction') or p->>'event_type' is null then
   raise exception using errcode='RP400',message='Invalid owner event type'; end if;
  if p->>'corrects_event_id' is not null then
   select * into ev from public.service_events where id=(p->>'corrects_event_id')::uuid and appliance_id=a.id;
   if not found or ev.author_id<>u or ev.event_type='transfer' then raise exception using errcode='RP400',message='Invalid correction reference'; end if;
  end if;
  insert into public.service_events(appliance_id,author_id,event_type,title,description,occurred_on,cost_minor,corrects_event_id)
   values(a.id,u,p->>'event_type',trim(p->>'title'),p->>'description',(p->>'occurred_on')::date,(p->>'cost_minor')::bigint,(p->>'corrects_event_id')::uuid) returning * into ev;
  return to_jsonb(ev);
 when 'document_create' then
  d.id:=gen_random_uuid();
  insert into public.documents(id,appliance_id,uploaded_by,kind,object_path,content_type,byte_size)
   values(d.id,a.id,u,p->>'kind',u::text||'/'||a.id::text||'/'||d.id::text,p->>'content_type',(p->>'byte_size')::integer) returning * into d;
  return to_jsonb(d);
 when 'request_create' then
  insert into public.repair_requests(appliance_id,author_id,symptoms,error_code)
   values(a.id,u,trim(p->>'symptoms'),p->>'error_code') returning * into r;
  return to_jsonb(r);
 when 'request_close','quote_create' then
  select * into r from public.repair_requests where id=rid and appliance_id=a.id and author_id=u;
  if not found then raise exception using errcode='RP404',message='Record not found'; end if;
  if p_action='request_close' then
   update public.repair_requests set status='closed' where id=r.id returning * into r;
   return to_jsonb(r);
  end if;
  if r.status<>'open' then raise exception using errcode='RP409',message='Problem report is closed'; end if;
  insert into public.quotes(repair_request_id,author_id,provider_label,part_description,parts_cost_minor,labor_cost_minor,visit_cost_minor,tax_cost_minor,total_cost_minor,warranty_days,exclusions)
   values(r.id,u,p->>'provider_label',p->>'part_description',(p->>'parts_cost_minor')::bigint,(p->>'labor_cost_minor')::bigint,(p->>'visit_cost_minor')::bigint,(p->>'tax_cost_minor')::bigint,(p->>'total_cost_minor')::bigint,(p->>'warranty_days')::integer,p->>'exclusions') returning * into q;
  return to_jsonb(q);
 when 'share_create' then
  h:=coalesce((p->>'expires_in_hours')::integer,24);
  if h not between 1 and 168 then raise exception using errcode='RP400',message='Expiry must be 1 to 168 hours'; end if;
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.share_links(appliance_id,created_by,token_hash,expires_at)
   values(a.id,u,encode(extensions.digest(raw_token,'sha256'),'hex'),clock_timestamp()+make_interval(hours=>h)) returning * into s;
  return jsonb_build_object('id',s.id,'token',raw_token,'expires_at',s.expires_at);
 when 'share_revoke' then
  update public.share_links set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=(p->>'share_link_id')::uuid and created_by=u returning * into s;
  if not found then raise exception using errcode='RP404',message='Record not found'; end if;
  return jsonb_build_object('id',s.id,'revoked_at',s.revoked_at);
 when 'transfer_invite' then
  v_email:=lower(trim(p->>'recipient_email'));
  if v_email is null or length(v_email)>254 or v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception using errcode='RP400',message='Valid recipient email required'; end if;
  if exists(select 1 from auth.users where id=u and lower(auth.users.email)=v_email) then raise exception using errcode='RP400',message='Recipient must be another person'; end if;
  h:=coalesce((p->>'expires_in_hours')::integer,24);
  if h not between 1 and 72 then raise exception using errcode='RP400',message='Expiry must be 1 to 72 hours'; end if;
  update public.transfers set status='revoked' where appliance_id=a.id and status='pending';
  raw_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.transfers(appliance_id,from_owner_id,recipient_email,token_hash,expires_at)
   values(a.id,u,v_email,encode(extensions.digest(raw_token,'sha256'),'hex'),clock_timestamp()+make_interval(hours=>h)) returning * into t;
  return jsonb_build_object('id',t.id,'token',raw_token,'recipient_email',t.recipient_email,'expires_at',t.expires_at);
 when 'transfer_revoke' then
  select * into t from public.transfers where id=(p->>'transfer_id')::uuid and from_owner_id=u;
  if not found then raise exception using errcode='RP404',message='Record not found'; end if;
  if t.status='accepted' then raise exception using errcode='RP409',message='Transfer already accepted'; end if;
  update public.transfers set status='revoked' where id=t.id;
  return jsonb_build_object('id',t.id,'status','revoked');
 end case;
 raise exception using errcode='RP400',message='Unknown action';
exception
 when unique_violation then raise exception using errcode='RP409',message='Record conflicts with existing data';
 when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range or check_violation or not_null_violation or foreign_key_violation then
  raise exception using errcode='RP400',message='Invalid field value';
end;
$$;
revoke all on function public.passport_mutate(text,jsonb) from public,anon,authenticated;
grant execute on function public.passport_mutate(text,jsonb) to authenticated;

create function public.buyer_summary(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.share_links; a public.appliances; history jsonb;
begin
 if p_token is null or p_token!~'^[0-9a-f]{64}$' then raise exception using errcode='RP404',message='Buyer link unavailable'; end if;
 -- Same lock order as mutations: appliance then share. Serializes with transfer/revocation.
 select appliance_id into s.appliance_id from public.share_links where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 select * into a from public.appliances where id=s.appliance_id for share;
 select * into s from public.share_links where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
 if s.id is null or s.revoked_at is not null or s.expires_at<=clock_timestamp() or s.created_by<>a.owner_id then
  raise exception using errcode='RP404',message='Buyer link unavailable'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'event_type',e.event_type,'occurred_on',e.occurred_on,
  'cost_minor',e.cost_minor,'currency',e.currency,'corrects_event_id',e.corrects_event_id,'attribution',e.attribution)
  order by e.occurred_on,e.created_at),'[]'::jsonb) into history
 from (select * from public.service_events where appliance_id=a.id order by occurred_on desc,created_at desc limit 1000) e;
 return jsonb_build_object('appliance',jsonb_build_object('brand',a.brand,'model',a.model,'category',a.category),'events',history,
  'history_notice','Owner-reported records; absence of records does not mean absence of repairs.');
end;
$$;
revoke all on function public.buyer_summary(text) from public,anon,authenticated;
grant execute on function public.buyer_summary(text) to anon,authenticated;

create function public.claim_support_lookup(p_appliance_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.appliances;
begin
 if auth.uid() is null then raise exception using errcode='RP401',message='Sign in required'; end if;
 select * into a from public.appliances where id=p_appliance_id and owner_id=auth.uid() for update;
 if not found then raise exception using errcode='RP404',message='Record not found'; end if;
 if a.support_lookup_at>clock_timestamp()-interval '60 seconds' then raise exception using errcode='RP429',message='Wait 60 seconds before another lookup'; end if;
 update public.appliances set support_lookup_at=clock_timestamp() where id=a.id;
 return jsonb_build_object('brand',a.brand,'model',a.model);
end;
$$;
revoke all on function public.claim_support_lookup(uuid) from public,anon,authenticated;
grant execute on function public.claim_support_lookup(uuid) to authenticated;

-- Private originals remain accessible only to their uploader WHILE still current owner.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('repair-documents','repair-documents',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']);
create function rp_private.document_access(p_path text,p_metadata jsonb default null) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.documents d join public.appliances a on a.id=d.appliance_id
 where d.object_path=p_path and d.uploaded_by=auth.uid() and a.owner_id=auth.uid()
 -- Storage's canUpload probe supplies mimetype/contentLength; final metadata supplies size.
 -- Multipart probes may not know a length yet. Validate any supplied length and the final size.
 and (p_metadata is null or (
  p_metadata->>'mimetype'=d.content_type
  and (not(p_metadata?'size') or p_metadata->>'size'=d.byte_size::text)
  and (not(p_metadata?'contentLength') or p_metadata->>'contentLength'=d.byte_size::text)
 )));
$$;
revoke all on function rp_private.document_access(text,jsonb) from public;
grant execute on function rp_private.document_access(text,jsonb) to authenticated;
create policy rp_document_upload on storage.objects for insert to authenticated
 with check(bucket_id='repair-documents' and rp_private.document_access(name,metadata));
create policy rp_document_download on storage.objects for select to authenticated
 using(bucket_id='repair-documents' and rp_private.document_access(name));
-- Existing permissive policies cannot accidentally broaden this bucket's access.
-- These restrictive guards leave all other buckets unchanged.
grant usage on schema rp_private to anon;
grant execute on function rp_private.document_access(text,jsonb) to anon;
create policy rp_document_select_guard on storage.objects as restrictive for select to anon,authenticated
 using(bucket_id<>'repair-documents' or rp_private.document_access(name));
create policy rp_document_insert_guard on storage.objects as restrictive for insert to anon,authenticated
 with check(bucket_id<>'repair-documents' or rp_private.document_access(name,metadata));
create policy rp_document_update_guard on storage.objects as restrictive for update to anon,authenticated
 using(bucket_id<>'repair-documents') with check(bucket_id<>'repair-documents');
create policy rp_document_delete_guard on storage.objects as restrictive for delete to anon,authenticated
 using(bucket_id<>'repair-documents');
commit;
