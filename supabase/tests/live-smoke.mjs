// Run only against the intended deployed project with two dedicated confirmed test accounts.
// Writes clearly labelled demo records; intentionally does not reset/delete database contents.
import assert from 'node:assert/strict';
const env=process.env;
for(const key of ['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','RP_OWNER_EMAIL','RP_OWNER_PASSWORD','RP_RECIPIENT_EMAIL','RP_RECIPIENT_PASSWORD','SITE_URL']) {
 if(!env[key]) throw new Error(`Missing environment variable: ${key}`);
}
assert.notEqual(env.RP_OWNER_EMAIL.toLowerCase(),env.RP_RECIPIENT_EMAIL.toLowerCase());
const base=env.SUPABASE_URL.replace(/\/$/,'');
const apikey=env.SUPABASE_PUBLISHABLE_KEY;
const site=env.SITE_URL.replace(/\/$/,'');
async function call(path,body,session=null,options={}) {
 const headers={apikey, ...options.headers};
 if(session)headers.Authorization=`Bearer ${session.access_token}`;
 if(body!==undefined && !options.raw)headers['Content-Type']='application/json';
 const res=await fetch(base+path,{method:options.method??'POST',headers,body:body===undefined?undefined:options.raw?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const text=await res.text();let value;try{value=JSON.parse(text);}catch{value=text;}
 return {status:res.status,value};
}
async function login(email,password){
 const r=await call('/auth/v1/token?grant_type=password',{email,password});
 assert.equal(r.status,200,`Login failed (${r.status}); check dedicated confirmed test accounts`);
 return r.value;
}
const owner=await login(env.RP_OWNER_EMAIL,env.RP_OWNER_PASSWORD);
const recipient=await login(env.RP_RECIPIENT_EMAIL,env.RP_RECIPIENT_PASSWORD);
async function action(name,payload,session=owner,status=200){
 const r=await call('/functions/v1/passport',{action:name,payload},session);
 assert.equal(r.status,status,`${name}: ${JSON.stringify(r.value)}`);
 return r.value.data;
}
async function rows(table,query,session){
 const r=await call(`/rest/v1/${table}?${query}`,undefined,session,{method:'GET'});
 assert.equal(r.status,200,`Read ${table} failed`);return r.value;
}
async function assistant(name,payload,session=owner,status=200){
 const r=await call('/functions/v1/repair-assistant',{action:name,payload},session);
 assert.equal(r.status,status,`${name}: ${JSON.stringify(r.value)}`);return r.value.data;
}
const catalogue=await assistant('list_products',{},null);
assert.equal(catalogue.products[0].full_model,'WW80T504DAN1TL');
const overview=await assistant('components',{product_id:catalogue.products[0].id},null);
assert.equal(overview.diagram.exact_geometry,false);
const appliance=await action('appliance_create',{brand:'Samsung',model:'WW80T504DAN1TL',nickname:`Integration smoke ${Date.now()}`});
const assessmentInput={appliance_id:appliance.id,symptoms:'Water remains after the cycle',scenario:'no_drain',answers:{hazard_present:'no',water_remaining:'yes',drain_hose_kinked:'no',filter_condition:'clear'}};
const assessment=await assistant('assess',assessmentInput);
assert.equal(assessment.status,'possible_causes');assert.equal(assessment.is_ai_generated,false);
await assistant('assess',assessmentInput,recipient,404);
const refreshed=await login(env.RP_OWNER_EMAIL,env.RP_OWNER_PASSWORD);
assert.equal((await rows('appliances',`id=eq.${appliance.id}&select=*`,refreshed)).length,1);
assert.equal((await rows('appliances',`id=eq.${appliance.id}&select=*`,recipient)).length,0);
const event=await action('event_append',{appliance_id:appliance.id,event_type:'repair',title:'Smoke test owner-reported repair',description:'PRIVATE-OWNER-NOTE',occurred_on:new Date().toISOString().slice(0,10),cost_minor:100});
const file=new TextEncoder().encode('%PDF-1.4\nRepairPassport private test invoice\n%%EOF');
const doc=await action('document_create',{appliance_id:appliance.id,kind:'invoice',content_type:'application/pdf',byte_size:file.byteLength});
const path='/storage/v1/object/repair-documents/'+doc.object_path;
const upload=await call(path,file,owner,{raw:true,headers:{'Content-Type':'application/pdf','x-upsert':'false'}});
assert.ok([200,201].includes(upload.status),`Upload failed: ${JSON.stringify(upload.value)}`);
assert.equal((await call(path,undefined,owner,{method:'GET'})).status,200);
assert.notEqual((await call(path,undefined,recipient,{method:'GET'})).status,200);
assert.equal((await rows('documents',`id=eq.${doc.id}&select=*`,recipient)).length,0);
const report=await action('request_create',{appliance_id:appliance.id,symptoms:'Demo drainage issue'});
const quote=await action('quote_create',{repair_request_id:report.id,provider_label:null,part_description:null,parts_cost_minor:null,labor_cost_minor:0,visit_cost_minor:null,tax_cost_minor:null,total_cost_minor:100,warranty_days:null,exclusions:null});
assert.equal(quote.parts_cost_minor,null);assert.equal(quote.labor_cost_minor,0);
const share=await action('share_create',{appliance_id:appliance.id});
const buyer=await action('buyer_summary',{token:share.token},null);
assert.equal(buyer.appliance.model,appliance.model);
assert.ok(!JSON.stringify(buyer).includes('PRIVATE-OWNER-NOTE'));
assert.ok(!JSON.stringify(buyer).includes(doc.object_path));
// A fresh anonymous request reproduces the API side of a second device; scan the QR manually too.
const buyerPage=await fetch(site+'/buyer',{signal:AbortSignal.timeout(15000)});
assert.equal(buyerPage.status,200,'Buyer SPA fallback unavailable');
const preflight=await fetch(base+'/functions/v1/passport',{method:'OPTIONS',headers:{Origin:site,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,apikey,content-type'},signal:AbortSignal.timeout(10000)});
assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),site);
const invitation=await action('transfer_invite',{appliance_id:appliance.id,recipient_email:env.RP_RECIPIENT_EMAIL});
const accepted=await action('transfer_accept',{token:invitation.token},recipient);
assert.equal(accepted.status,'accepted');
await assistant('assess',assessmentInput,owner,404);
assert.equal((await assistant('assess',assessmentInput,recipient)).status,'possible_causes');
await action('transfer_accept',{token:invitation.token},recipient,409);
await action('buyer_summary',{token:share.token},null,404);
await action('event_append',{appliance_id:appliance.id,event_type:'repair',title:'Must fail',occurred_on:new Date().toISOString().slice(0,10)},owner,404);
assert.equal((await rows('appliances',`id=eq.${appliance.id}&select=*`,owner)).length,0);
assert.equal((await rows('appliances',`id=eq.${appliance.id}&select=*`,recipient)).length,1);
assert.equal((await rows('service_events',`appliance_id=eq.${appliance.id}&select=id`,recipient)).length,2);
assert.equal((await rows('documents',`appliance_id=eq.${appliance.id}&select=id`,recipient)).length,0);
assert.notEqual((await call(path,undefined,owner,{method:'GET'})).status,200);
assert.notEqual((await call(path,undefined,recipient,{method:'GET'})).status,200);
const old=await call('/rest/v1/appliances?id=eq.'+appliance.id,{owner_id:owner.user.id},recipient,{method:'PATCH'});
assert.notEqual(old.status,200);assert.notEqual(old.status,204);
console.log(JSON.stringify({status:'passed',appliance_id:appliance.id,working:['persistence across reauthentication','private row/document isolation','anonymous buyer API','buyer SPA fallback','deployed CORS','structured unknown quote fields','public component catalogue','owner-scoped guided assessment','single-use transfer','old owner denied','history retained','old shares revoked'],manual_checks_remaining:['scan buyer QR on another device','frontend refresh/logout/session flow','Auth confirmation callback']},null,2));
