-- Read-only remote inspection. Run before applying any migration to the intended project.
select current_database(),current_user,version();
select table_schema,table_name from information_schema.tables
 where table_schema='public' and table_name in ('appliances','service_events','documents','repair_requests','quotes','share_links','transfers');
select e.extname,n.nspname as extension_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
select schema_name from information_schema.schemata where schema_name='rp_private';
select id,name,public,file_size_limit,allowed_mime_types from storage.buckets where id='repair-documents';
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in ('public','storage');
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,p.prosecdef,p.proacl
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('passport_mutate','buyer_summary','claim_support_lookup');
