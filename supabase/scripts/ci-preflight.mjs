// Read-only inspection of the intended hosted project before CLI migrations.
import assert from 'node:assert/strict';
const ref=process.env.SUPABASE_PROJECT_REF;
assert.equal(ref,'xhkjqtknjwxzbabnirsy','Refusing an unintended Supabase project');
const token=process.env.SUPABASE_ACCESS_TOKEN;
assert.ok(token,'Missing Supabase management access token');
async function query(sql){
 const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{
  method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql,read_only:true}),redirect:'error',signal:AbortSignal.timeout(30000),
 });
 if(!r.ok)throw new Error(`Read-only project preflight failed (${r.status}); check token access to the existing project`);
 const rows=await r.json();if(!Array.isArray(rows))throw new Error('Unexpected preflight result');return rows;
}
const rows=await query(`select
 to_regclass('supabase_migrations.schema_migrations') is not null as has_history,
 (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('appliances','service_events','documents','repair_requests','quotes','share_links','transfers')) as app_tables,
 exists(select 1 from pg_namespace where nspname='rp_private') as has_private_schema,
 exists(select 1 from storage.buckets where id='repair-documents') as has_bucket`);
assert.equal(rows.length,1);
const state=rows[0];let migrated=false;
if(state.has_history){
 const history=await query("select exists(select 1 from supabase_migrations.schema_migrations where version='202611150001') as applied");
 migrated=history[0]?.applied===true;
}
if(!migrated&&(state.app_tables!==0||state.has_private_schema||state.has_bucket))throw new Error('Existing RepairPassport resource names have no matching migration history. Stop and reconcile additively; no resets or history repair will be attempted.');
if(migrated&&state.app_tables!==7)throw new Error('Migration history exists but expected tables are missing; inspect drift before deployment.');
console.log(migrated?'Existing RepairPassport migration found; proceeding without recreating resources.':'No conflicting RepairPassport resources found; additive migration can proceed.');
