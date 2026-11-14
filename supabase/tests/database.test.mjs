import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
const alice='11111111-1111-4111-8111-111111111111';
const bob='22222222-2222-4222-8222-222222222222';
const eve='33333333-3333-4333-8333-333333333333';
const unconfirmed='44444444-4444-4444-8444-444444444444';
let appliance, event, correction, document, report, quote, share, invitation;
async function actor(id, fn) {
 await db.exec(`set role ${id ? 'authenticated':'anon'}`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
 try { return await fn(); } finally { await db.exec('reset role'); }
}
async function rpc(action,payload) {
 const r=await db.query('select public.passport_mutate($1,$2::jsonb) as result',[action,JSON.stringify(payload)]);
 return r.rows[0].result;
}
async function buyer(token) {
 return (await db.query('select public.buyer_summary($1) as result',[token])).rows[0].result;
}
async function fails(code,fn) { await assert.rejects(fn,err=>{ assert.equal(err.code,code,err.message); return true; }); }
before(async()=>{
 await db.exec(await readFile(new URL('./bootstrap.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../migrations/202611150001_repairpassport.sql',import.meta.url),'utf8'));
 await db.query("insert into auth.users values($1,'alice@example.test',now()),($2,'bob@example.test',now()),($3,'eve@example.test',now()),($4,'waiting@example.test',null)",[alice,bob,eve,unconfirmed]);
});
after(()=>db.close());

test('owner creates and rereads persisted appliance; unrelated and anonymous see nothing',async()=>{
 appliance=await actor(alice,()=>rpc('appliance_create',{brand:'Bosch',model:'WM-1',serial_number:'PRIVATE-SERIAL',nickname:'Alice home'}));
 assert.equal(appliance.owner_id,alice);
 await actor(alice,async()=>assert.equal((await db.query('select * from public.appliances')).rows[0].id,appliance.id));
 await actor(bob,async()=>assert.equal((await db.query('select * from public.appliances')).rows.length,0));
 await actor(null,()=>fails('42501',()=>db.query('select * from public.appliances')));
 await actor(null,()=>fails('42501',()=>rpc('appliance_create',{brand:'X',model:'Y'})));
});
test('direct writes and forged author/owner/attribution are rejected',async()=>{
 await actor(alice,async()=>{
  await fails('42501',()=>db.query('update public.appliances set owner_id=$1 where id=$2',[bob,appliance.id]));
  await fails('42501',()=>db.query("insert into public.service_events(appliance_id,author_id,event_type,title,occurred_on) values($1,$2,'repair','fake',current_date)",[appliance.id,alice]));
  await fails('RP400',()=>rpc('appliance_update',{appliance_id:appliance.id,owner_id:bob}));
  await fails('RP400',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'repair',title:'x',occurred_on:'2026-11-15',author_id:bob}));
 });
 await actor(bob,()=>fails('RP404',()=>rpc('appliance_update',{appliance_id:appliance.id,brand:'stolen'})));
});
test('events immutable; corrections must reference same appliance and author',async()=>{
 event=await actor(alice,()=>rpc('event_append',{appliance_id:appliance.id,event_type:'repair',title:'Private invoice 123',description:'Alice phone 9999999999',occurred_on:'2026-11-15',cost_minor:180000}));
 correction=await actor(alice,()=>rpc('event_append',{appliance_id:appliance.id,event_type:'correction',title:'Corrected cost',occurred_on:'2026-11-15',cost_minor:170000,corrects_event_id:event.id}));
 await actor(alice,()=>fails('RP409',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'correction',title:'Duplicate',occurred_on:'2026-11-15',corrects_event_id:event.id})));
 await actor(alice,()=>fails('RP400',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'transfer',title:'forged',occurred_on:'2026-11-15'})));
 await actor(alice,()=>fails('RP400',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'correction',title:'no original',occurred_on:'2026-11-15'})));
 const other=await actor(alice,()=>rpc('appliance_create',{brand:'LG',model:'other'}));
 await actor(alice,()=>fails('RP400',()=>rpc('event_append',{appliance_id:other.id,event_type:'correction',title:'wrong appliance',occurred_on:'2026-11-15',corrects_event_id:correction.id})));
 await fails('RP403',()=>db.query('update public.service_events set title=$1 where id=$2',['overwrite',event.id]));
 await fails('RP403',()=>db.query('delete from public.service_events where id=$1',[event.id]));
});
test('private uploads require reservation, exact MIME/size, owner and uploader even with broad legacy policies',async()=>{
 document=await actor(alice,()=>rpc('document_create',{appliance_id:appliance.id,kind:'invoice',content_type:'application/pdf',byte_size:100}));
 assert.equal(document.object_path,`${alice}/${appliance.id}/${document.id}`);
 // Real Storage authorization probe happens before final object metadata exists.
 for(const metadata of [null,{mimetype:'application/pdf'},{mimetype:'application/pdf',contentLength:100}]) {
  await actor(alice,async()=>assert.equal((await db.query('select rp_private.document_access($1,$2) as allowed',[document.object_path,metadata])).rows[0].allowed,true));
 }
 await actor(alice,async()=>assert.equal((await db.query('select rp_private.document_access($1,$2) as allowed',[document.object_path,{mimetype:'application/pdf',contentLength:99}])).rows[0].allowed,false));
 await actor(alice,()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('repair-documents',$1,$2)",[document.object_path,{mimetype:'application/pdf',size:100}]));
 await actor(alice,async()=>assert.equal((await db.query('select * from storage.objects')).rows.length,1));
 await actor(bob,async()=>{
  assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  assert.equal((await db.query('select * from public.documents')).rows.length,0);
  await fails('42501',()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('repair-documents',$1,$2)",[document.object_path,{mimetype:'application/pdf',size:100}]));
 });
 const wrong=await actor(alice,()=>rpc('document_create',{appliance_id:appliance.id,kind:'photo',content_type:'image/jpeg',byte_size:10}));
 await actor(alice,()=>fails('42501',()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('repair-documents',$1,$2)",[wrong.object_path,{mimetype:'image/png',size:10}])));
 await actor(alice,()=>fails('42501',()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('repair-documents',$1,$2)",[wrong.object_path,{mimetype:'image/jpeg',size:11}])));
 await actor(alice,async()=>assert.equal((await db.query("delete from storage.objects where bucket_id='repair-documents' returning id")).rows.length,0));
 await actor(null,async()=>assert.equal((await db.query('select * from storage.objects')).rows.length,0));
});
test('problem reports and quotes require explicit unknowns and preserve null versus zero',async()=>{
 report=await actor(alice,()=>rpc('request_create',{appliance_id:appliance.id,symptoms:'Not draining',error_code:null}));
 const fields={repair_request_id:report.id,provider_label:null,part_description:null,parts_cost_minor:null,labor_cost_minor:0,visit_cost_minor:null,tax_cost_minor:null,total_cost_minor:180000,warranty_days:null,exclusions:null};
 quote=await actor(alice,()=>rpc('quote_create',fields));
 assert.equal(quote.parts_cost_minor,null); assert.equal(quote.labor_cost_minor,0);
 const missing={...fields}; delete missing.exclusions;
 await actor(alice,()=>fails('RP400',()=>rpc('quote_create',missing)));
 for(const bad of [-1,1.5,'100',true,{},100000001]) await actor(alice,()=>fails('RP400',()=>rpc('quote_create',{...fields,total_cost_minor:bad})));
 await actor(bob,()=>fails('RP404',()=>rpc('quote_create',fields)));
 await actor(bob,async()=>{assert.equal((await db.query('select * from public.repair_requests')).rows.length,0);assert.equal((await db.query('select * from public.quotes')).rows.length,0);});
 await actor(alice,()=>rpc('request_close',{repair_request_id:report.id}));
 await actor(alice,()=>fails('RP409',()=>rpc('quote_create',fields)));
});
test('buyer summary is anonymous, narrowly allowlisted and revocable/expiring',async()=>{
 share=await actor(alice,()=>rpc('share_create',{appliance_id:appliance.id}));
 assert.match(share.token,/^[0-9a-f]{64}$/);
 const result=await actor(null,()=>buyer(share.token));
 assert.deepEqual(Object.keys(result.appliance).sort(),['brand','category','model']);
 assert.deepEqual(Object.keys(result.events[0]).sort(),['attribution','corrects_event_id','cost_minor','currency','event_type','id','occurred_on']);
 for(const secret of ['PRIVATE-SERIAL','Alice','9999999999',alice,document.object_path,'Private invoice']) assert.ok(!JSON.stringify(result).includes(secret),secret);
 await actor(alice,()=>fails('42501',()=>db.query('select token_hash from public.share_links')));
 const revoked=await actor(alice,()=>rpc('share_create',{appliance_id:appliance.id}));
 await actor(alice,()=>rpc('share_revoke',{share_link_id:revoked.id}));
 await actor(null,()=>fails('RP404',()=>buyer(revoked.token)));
 const expired=await actor(alice,()=>rpc('share_create',{appliance_id:appliance.id}));
 await db.query("update public.share_links set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 await actor(null,()=>fails('RP404',()=>buyer(expired.token)));
 await actor(null,()=>fails('RP404',()=>buyer('not-a-token')));
});
test('support cooldown is owner-bound, atomic and rejects repeat claims',async()=>{
 await actor(bob,()=>fails('RP404',()=>db.query('select public.claim_support_lookup($1)',[appliance.id])));
 const claim=await actor(alice,()=>db.query('select public.claim_support_lookup($1) as result',[appliance.id]));
 assert.deepEqual(claim.rows[0].result,{brand:'Bosch',model:'WM-1'});
 await actor(alice,()=>fails('RP429',()=>db.query('select public.claim_support_lookup($1)',[appliance.id])));
});
test('transfer validates recipient, confirmation, expiry, cancellation and distinct tokens',async()=>{
 await actor(alice,()=>fails('RP400',()=>rpc('transfer_invite',{appliance_id:appliance.id,recipient_email:'alice@example.test'})));
 const waiting=await actor(alice,()=>rpc('transfer_invite',{appliance_id:appliance.id,recipient_email:'waiting@example.test'}));
 await actor(unconfirmed,()=>fails('RP403',()=>rpc('transfer_accept',{token:waiting.token})));
 const expired=await actor(alice,()=>rpc('transfer_invite',{appliance_id:appliance.id,recipient_email:'bob@example.test'}));
 await actor(unconfirmed,()=>fails('RP403',()=>rpc('transfer_accept',{token:waiting.token})));
 await db.query("update public.transfers set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 await actor(bob,()=>fails('RP410',()=>rpc('transfer_accept',{token:expired.token})));
 const revoked=await actor(alice,()=>rpc('transfer_invite',{appliance_id:appliance.id,recipient_email:'bob@example.test'}));
 await actor(alice,()=>rpc('transfer_revoke',{transfer_id:revoked.id}));
 await actor(bob,()=>fails('RP409',()=>rpc('transfer_accept',{token:revoked.token})));
 invitation=await actor(alice,()=>rpc('transfer_invite',{appliance_id:appliance.id,recipient_email:'BOB@example.test'}));
 assert.equal(invitation.recipient_email,'bob@example.test');
 await actor(eve,()=>fails('RP403',()=>rpc('transfer_accept',{token:invitation.token})));
 await actor(alice,()=>fails('RP403',()=>rpc('transfer_accept',{token:invitation.token})));
 await actor(bob,()=>fails('RP404',()=>rpc('transfer_accept',{token:share.token})));
 await actor(null,()=>fails('RP404',()=>buyer(invitation.token)));
 await actor(alice,()=>fails('42501',()=>db.query('select token_hash from public.transfers')));
});
test('acceptance commits ownership/event/revocation together; replay denied; history survives',async()=>{
 // Force event insertion failure to demonstrate complete transaction rollback.
 await db.exec("create function rp_private.test_fail_transfer() returns trigger language plpgsql as $$ begin if new.event_type='transfer' then raise exception 'test failure'; end if; return new; end; $$; create trigger fail_transfer before insert on public.service_events for each row execute function rp_private.test_fail_transfer();");
 await actor(bob,()=>fails('P0001',()=>rpc('transfer_accept',{token:invitation.token})));
 assert.equal((await db.query('select owner_id from public.appliances where id=$1',[appliance.id])).rows[0].owner_id,alice);
 assert.equal((await db.query('select status from public.transfers where id=$1',[invitation.id])).rows[0].status,'pending');
 await actor(null,()=>buyer(share.token));
 await db.exec('drop trigger fail_transfer on public.service_events; drop function rp_private.test_fail_transfer()');
 const accepted=await actor(bob,()=>rpc('transfer_accept',{token:invitation.token}));
 assert.equal(accepted.status,'accepted');
 await actor(bob,()=>fails('RP409',()=>rpc('transfer_accept',{token:invitation.token})));
 await actor(null,()=>fails('RP404',()=>buyer(share.token)));
 await actor(alice,async()=>{
  assert.equal((await db.query('select * from public.appliances where id=$1',[appliance.id])).rows.length,0);
  assert.equal((await db.query('select * from public.service_events where appliance_id=$1',[appliance.id])).rows.length,0);
  assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  await fails('RP404',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'repair',title:'no longer mine',occurred_on:'2026-11-15'}));
 });
 await actor(bob,async()=>{
  assert.equal((await db.query('select owner_id from public.appliances where id=$1',[appliance.id])).rows[0].owner_id,bob);
  assert.equal((await db.query('select * from public.service_events where appliance_id=$1',[appliance.id])).rows.length,3);
  assert.equal((await db.query('select * from public.documents')).rows.length,0);
  assert.equal((await db.query('select * from storage.objects')).rows.length,0);
  assert.equal((await db.query('select * from public.repair_requests')).rows.length,0);
  assert.equal((await db.query('select * from public.quotes')).rows.length,0);
  await fails('RP400',()=>rpc('event_append',{appliance_id:appliance.id,event_type:'correction',title:'someone else history',occurred_on:'2026-11-15',corrects_event_id:correction.id}));
  const next=await rpc('event_append',{appliance_id:appliance.id,event_type:'maintenance',title:'New owner event',occurred_on:'2026-11-15'});
  assert.equal(next.author_id,bob);
 });
});
