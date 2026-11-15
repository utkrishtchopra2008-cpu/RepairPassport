import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../functions/repair-assistant/index.ts';
import {createHandler as supportHandler} from '../functions/support-lookup/index.ts';
import {product,componentOverview,resolveProduct,components,sources} from '../functions/_shared/catalog.ts';
import {assess,validateAnswers} from '../functions/_shared/assessment.ts';
import {validateShopQuery,normalizeShops,overpassQuery,searchArea} from '../functions/_shared/shops.ts';
import type {Dependencies} from '../functions/_shared/http.ts';

const id='11111111-1111-4111-8111-111111111111';
const appliance={id,brand:product.brand,model:product.full_model,category:'washing_machine'};
const config:Record<string,string>={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-key',TINYFISH_API_KEY:'private-tinyfish-key',ALLOWED_ORIGINS:'https://repair.example'};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
const base={appliance_id:id,symptoms:'Water remains after the cycle',scenario:'no_drain'};
const fullDrain={hazard_present:'no',water_remaining:'yes',drain_hose_kinked:'no',filter_condition:'clear'};
const query={appliance_id:id,latitude:28.631231,longitude:77.216759,location_consent:true,radius_km:5};
const shop=(id:number,extra:Record<string,unknown>={})=>({type:'node',id,lat:28.632,lon:77.217,tags:{name:`Repair ${id}`,shop:'appliance',repair:'yes'},...extra});
function request(action:string,payload:unknown,auth=true,origin='https://repair.example'){
 return new Request('https://example.supabase.co/functions/v1/repair-assistant',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(auth?{Authorization:'Bearer user-session'}:{})},body:JSON.stringify({action,payload})});
}
function deps(handler?:(url:string,init?:RequestInit)=>Promise<Response>,overrides:Record<string,string>={}):Dependencies{
 return {env:k=>({...config,...overrides})[k],fetch:async(input,init)=>{
  const url=String(input);if(handler){const r=await handler(url,init);if(r)return r;}
  if(url.endsWith('/auth/v1/user'))return json({id});
  if(url.includes('/rest/v1/appliances?'))return json([appliance]);
  if(url.includes('/rpc/claim_support_lookup'))return json({brand:appliance.brand,model:appliance.model});
  if(url.includes('overpass'))return json({elements:[]});
  throw new Error('Unexpected upstream');
 }};
}

test('catalogue resolves exact variant only and never substitutes a different product',()=>{
 assert.equal(resolveProduct('Samsung','WW80T504DAN','1TL').status,'supported');
 assert.equal(resolveProduct('samsung','ww80t504dan1tl').status,'supported');
 assert.equal(resolveProduct('Samsung','WW80T504DAN').status,'variant_required');
 for(const [brand,model,variant] of [['LG',product.full_model,'1TL'],['Samsung','WW80T504DAN','EU'],['Samsung',product.full_model,'EU'],['Samsung','unknown','']])assert.equal(resolveProduct(brand,model,variant).status,'unsupported');
 const overview=componentOverview(product.id);
 assert.equal(overview.status,'supported');assert.equal(overview.diagram?.exact_geometry,false);
 assert.equal(componentOverview('made-up-product').status,'unsupported');
 const ids=new Set(components.map(c=>c.id));const sourceIds=new Set(sources.map(s=>s.id));
 for(const c of components){assert.ok(c.function.length>0);for(const s of c.source_ids)assert.ok(sourceIds.has(s));}
 for(const edge of overview.connections!){assert.ok(ids.has(edge.from));assert.ok(ids.has(edge.to));}
});
test('catalogue actions work anonymously with no database or external request',async()=>{
 let calls=0;const handler=createHandler(deps(async()=>{calls++;throw new Error('No upstream expected');}));
 const list=await handler(request('list_products',{},false));assert.equal(list.status,200);assert.equal((await list.json()).data.products[0].id,product.id);
 assert.equal((await handler(request('components',{product_id:product.id},false))).status,200);
 assert.equal((await (await handler(request('resolve_product',{brand:'Samsung',model:'WW80T504DAN'},false))).json()).data.status,'variant_required');
 assert.equal(calls,0);
});
test('assessment requires actual owner read and a verified session',async()=>{
 const handler=createHandler(deps());
 assert.equal((await handler(request('assess',base,false))).status,401);
 const unrelated=createHandler(deps(async(url)=>url.includes('/rest/v1/appliances?')?json([]):undefined as never));
 assert.equal((await unrelated(request('assess',base))).status,404);
 const expired=createHandler(deps(async(url)=>url.endsWith('/auth/v1/user')?json({},401):undefined as never));
 assert.equal((await expired(request('assess',base))).status,401);
});
test('owner read requests allowlisted columns and forwards only session identity',async()=>{
 const calls:string[]=[];
 const handler=createHandler(deps(async(url,init)=>{
  calls.push(url);assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer user-session');
  assert.ok(!url.includes('serial_number'));assert.ok(!url.includes('documents'));
  return undefined as never;
 }));
 const result=await handler(request('assess',{...base,answers:fullDrain}));assert.equal(result.status,200);
 assert.equal(calls.length,2);assert.ok(calls[1].includes('select=id,brand,model,category'));
});
test('assessment rejects unexpected fields, invalid enums and fabricated observations',async()=>{
 const handler=createHandler(deps());
 for(const payload of [{...base,owner_id:id},{...base,scenario:'electrical_repair'},{...base,symptoms:''},{...base,answers:{motor_broken:'yes'}},{...base,answers:{hazard_present:true}},{...base,answers:[]},{...base,symptoms:'x'.repeat(2001)}])assert.equal((await handler(request('assess',payload))).status,400);
 assert.throws(()=>validateAnswers({__proto__:null,constructor:'yes'}));
});
test('missing and unknown answers stay unknown and prevent ordinary checks before hazard confirmation',()=>{
 const a=assess(appliance,base);assert.equal(a.status,'needs_answers');assert.ok(a.questions.some(q=>q.id==='hazard_present'));assert.deepEqual(a.safe_checks,[]);assert.deepEqual(a.candidates,[]);
 const b=assess(appliance,{...base,answers:{hazard_present:'no',water_remaining:'unknown'}});assert.ok(b.questions.some(q=>q.id==='water_remaining'));assert.equal(b.report.user_observations.answers.water_remaining,'unknown');
 assert.equal(b.engine,'curated_rules_v1');assert.equal(b.is_ai_generated,false);
});
test('drainage produces possible causes and never confirms a replacement',()=>{
 const a=assess(appliance,{...base,answers:{...fullDrain,drain_hose_kinked:'yes'}});
 assert.equal(a.status,'possible_causes');assert.ok(a.candidates.some(c=>c.component_ids.includes('drain_hose')));
 const b=assess(appliance,{...base,answers:fullDrain});assert.ok(b.candidates.some(c=>c.id==='drainage_subsystem_inspection'));
 assert.ok(b.notices.some(n=>n.includes('No part replacement')));
 assert.deepEqual(b.repair_request,{appliance_id:id,symptoms:base.symptoms,error_code:null});
});
test('spin with remaining water prioritizes drainage and asks drainage follow-ups',()=>{
 const result=assess(appliance,{...base,scenario:'no_spin',symptoms:'Does not spin',answers:{hazard_present:'no',water_remaining:'yes',drum_moves_during_wash:'no'}});
 assert.ok(result.candidates.some(c=>c.component_ids.includes('pump_filter')));
 assert.ok(!result.candidates.some(c=>c.component_ids.includes('motor')));
 assert.ok(result.questions.some(q=>q.id==='filter_condition'));
});
test('vibration distinguishes setup/load from unconfirmed internal damage',()=>{
 const result=assess(appliance,{symptoms:'Shaking',scenario:'vibration',answers:{hazard_present:'no',load_unbalanced:'yes',machine_level:'no',shipping_bolts_removed:'no'}});
 assert.equal(result.status,'possible_causes');
 for(const id of ['drum','leveling_feet','shipping_bolts'])assert.ok(result.candidates.some(c=>c.component_ids.includes(id)));
 assert.ok(!result.candidates.some(c=>/bearing|replace/i.test(c.summary)));
});
test('hazard observations suppress tests even when an answer incorrectly says no hazard',()=>{
 for(const symptoms of ['Smoke coming out','Sparks near plug','Burning smell','An electrical shock','It caught fire']){
  const result=assess(appliance,{...base,symptoms,answers:fullDrain});assert.equal(result.status,'professional_inspection');assert.deepEqual(result.candidates,[]);assert.deepEqual(result.safe_checks,[]);assert.ok(result.notices[0].includes('Stop using'));
 }
 const explicit=assess(appliance,{...base,answers:{hazard_present:'yes'}});assert.equal(explicit.status,'professional_inspection');
 const absent=assess(appliance,{...base,symptoms:'Water remains. No burning smell.',answers:fullDrain});assert.notEqual(absent.status,'professional_inspection');
});
test('unknown/ambiguous product or symptom never gets a fabricated assessment',()=>{
 assert.equal(assess({...appliance,model:'WW80T504DAN'},base).status,'unsupported_product');
 const unknown=assess(appliance,{symptoms:'It feels different',answers:{hazard_present:'no'}});assert.equal(unknown.status,'insufficient_information');assert.deepEqual(unknown.candidates,[]);
 const ambiguous=assess(appliance,{symptoms:'Not draining and not spinning',answers:fullDrain});assert.equal(ambiguous.scenario,'unknown');
 assert.equal(assess(appliance,{symptoms:'There is an error',error_code:'5C',answers:fullDrain}).scenario,'no_drain');
});
test('shop input rejects missing consent, arbitrary text/query/URL, invalid positions and radius',async()=>{
 const handler=createHandler(deps());
 for(const bad of [{...query,location_consent:false},{...query,latitude:91},{...query,longitude:181},{...query,latitude:'28'},{...query,radius_km:50},{...query,radius_km:null},{...query,radius_km:1.5},{...query,url:'https://evil.test'},{...query,require_listed_brand:'yes'}])assert.equal((await handler(request('find_shops',bad))).status,400);
 for(const latitude of [NaN,Infinity,-Infinity])assert.throws(()=>validateShopQuery({...query,latitude}));
 assert.equal(validateShopQuery(query).radius_km,5);
});
test('shop query is fixed, bounded and sends only rounded coordinates',()=>{
 const area=searchArea(validateShopQuery(query));assert.deepEqual(area,{latitude:28.631,longitude:77.217,radius_km:5});
 const q=overpassQuery(area);assert.ok(q.includes('[timeout:8]'));assert.ok(q.includes('out center 100'));assert.ok(!q.includes(String(query.latitude)));assert.ok(!q.includes(String(query.longitude)));
});
test('shop normalization uses real coordinates and explicit repair tags, not names or sales brands',()=>{
 const q=validateShopQuery(query);
 const rows=[shop(2,{lat:28.65}),shop(1),shop(3,{tags:{name:'Samsung Authorized Original Parts',shop:'appliance',repair:'yes',brand:'Samsung',phone:'javascript:evil'}}),shop(4,{tags:{name:'Listed',shop:'appliance',repair:'yes','repair:brand':'Samsung;LG','repair:washing_machines':'yes'}}),shop(5,{lat:0}),shop(6,{tags:{name:'No repair',shop:'appliance'}}),shop(7,{tags:{name:'Closed',shop:'appliance',repair:'yes',disused:'yes'}}),shop(1)];
 const result=normalizeShops(rows,q,'Samsung');assert.equal(result.length,4);assert.equal(result[0].id,'node/1');
 const sales=result.find(r=>r.id==='node/3')!;assert.equal(sales.brand_support,'unknown');assert.equal(sales.phone,null);assert.equal(sales.parts_availability,'unknown');assert.equal(sales.rating,null);
 const filtered=normalizeShops(rows,{...q,require_listed_brand:true,require_listed_category:true},'Samsung');assert.equal(filtered.length,1);assert.equal(filtered[0].id,'node/4');
 for(const row of result){assert.equal(row.verification,'community_listing_unverified');assert.ok(row.source_url.startsWith('https://www.openstreetmap.org/node/'));}
});
test('listing cache is bounded public data; ownership is checked even on cache hits',async()=>{
 let overpassCalls=0,claims=0,owner=true;
 const handler=createHandler(deps(async(url,init)=>{
  if(url.includes('/rest/v1/appliances?'))return json(owner?[appliance]:[]);
  if(url.includes('/rpc/claim_support_lookup')){claims++;return json({brand:appliance.brand,model:appliance.model});}
  if(url.includes('overpass')){overpassCalls++;assert.ok(!String(init!.body).includes(String(query.latitude)));assert.equal((init!.headers as Record<string,string>).Authorization,undefined);return json({elements:[shop(1)]});}
  return undefined as never;
 }));
 assert.equal((await (await handler(request('find_shops',query))).json()).data.status,'found');
 assert.equal((await (await handler(request('find_shops',query))).json()).data.status,'found');
 assert.equal(overpassCalls,1);assert.equal(claims,1);
 owner=false;assert.equal((await handler(request('find_shops',query))).status,404);assert.equal(overpassCalls,1);
});
test('real empty shop response stays empty and upstream errors never become fictional listings',async()=>{
 for(const [value,status,expected] of [[{elements:[]},200,'empty'],[{},500,'unavailable'],[{remark:'query timed out',elements:[]},200,'unavailable'],[{elements:[shop(1)],filler:'x'.repeat(1100000)},200,'unavailable']] as const){
  const handler=createHandler(deps(async url=>url.includes('overpass')?json(value,status):undefined as never));
  const result=await handler(request('find_shops',query));assert.equal(result.status,200);const data=(await result.json()).data;assert.equal(data.status,expected);assert.deepEqual(data.shops,[]);assert.equal(data.attribution,'© OpenStreetMap contributors (ODbL)');
 }
});
test('shop cooldown errors use stable error envelope and no provider call',async()=>{
 let calls=0;const handler=createHandler(deps(async url=>{
  if(url.includes('/rpc/claim_support_lookup'))return json({code:'RP429'},400);
  if(url.includes('overpass')){calls++;return json({elements:[]});}return undefined as never;
 }));
 const result=await handler(request('find_shops',query));assert.equal(result.status,429);assert.equal((await result.json()).error.code,'RATE_LIMITED');assert.equal(calls,0);
});
test('TinyFish manufacturer reference uses known model default and does not send private observations',async()=>{
 let calls=0;const handler=supportHandler(deps(async(url,init)=>{
  if(url.includes('api.fetch.tinyfish.ai')){calls++;assert.deepEqual(JSON.parse(String(init!.body)),{urls:[product.support_url]});return json({results:[{url:product.support_url,final_url:product.support_url,text:'Manufacturer reference'}]});}
  return undefined as never;
 },{MANUFACTURER_SUPPORT_URL:''}));
 const req=new Request('https://example.supabase.co/functions/v1/support-lookup',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://repair.example',Authorization:'Bearer user-session'},body:JSON.stringify({appliance_id:id})});
 const result=await handler(req);assert.equal((await result.json()).data.status,'found');assert.equal(calls,1);
});
