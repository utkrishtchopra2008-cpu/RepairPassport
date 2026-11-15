import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assess} from '../functions/_shared/assessment.ts';
import {reviewAssessment,validateRanking} from '../functions/_shared/ai-review.ts';
import {createHandler} from '../functions/repair-assistant/index.ts';
import {product} from '../functions/_shared/catalog.ts';
import type {Dependencies} from '../functions/_shared/http.ts';
const id='11111111-1111-4111-8111-111111111111';
const appliance={id,brand:product.brand,model:product.full_model,category:'washing_machine'};
const payload={appliance_id:id,symptoms:'PRIVATE USER TEXT water remains',error_code:'PRIVATE ERROR',scenario:'no_drain',ai_consent:true,answers:{hazard_present:'no',water_remaining:'yes',drain_hose_kinked:'no',filter_condition:'clear'}};
const assessment=assess(appliance,payload);
const ranking=()=>({ranking:assessment.candidates.map(c=>({candidate_id:c.id,evidence_indexes:[0],uncertainty:'needs_inspection'}))});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const apiResult=(value:unknown)=>json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
function deps(handler?:(url:string,init?:RequestInit)=>Promise<Response|undefined>,config:Record<string,string>={}):Dependencies{
 const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-key',ALLOWED_ORIGINS:'https://repair.example',OPENAI_API_KEY:'private-provider-key',OPENAI_MODEL:'configured-test-model',...config};
 return {env:k=>env[k as keyof typeof env],fetch:async(input,init)=>{
  const url=String(input);const override=await handler?.(url,init);if(override)return override;
  if(url.endsWith('/auth/v1/user'))return json({id});
  if(url.includes('/rest/v1/appliances?'))return json([appliance]);
  if(url.includes('/rpc/claim_support_lookup'))return json({brand:appliance.brand,model:appliance.model});
  if(url==='https://api.openai.com/v1/responses')return apiResult(ranking());
  throw new Error('Unexpected request');
 }};
}
function request(body:unknown,auth=true){return new Request('https://example.supabase.co/functions/v1/repair-assistant',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://repair.example',...(auth?{Authorization:'Bearer session'}:{})},body:JSON.stringify({action:'ai_review',payload:body})});}
test('AI review is opt-in, authenticated and owner-bound',async()=>{
 const handler=createHandler(deps());
 assert.equal((await handler(request({...payload,ai_consent:false}))).status,400);
 const missing={...payload} as Record<string,unknown>;delete missing.ai_consent;
 assert.equal((await handler(request(missing))).status,400);
 assert.equal((await handler(request(payload,false))).status,401);
 const unrelated=createHandler(deps(async url=>url.includes('/rest/v1/appliances?')?json([]):undefined));
 assert.equal((await unrelated(request(payload))).status,404);
});
test('missing provider configuration returns intact rule assessment without a provider/cooldown call',async()=>{
 let calls=0;const handler=createHandler(deps(async url=>{if(url.includes('/rpc/')||url.includes('api.openai.com')){calls++;throw new Error('No paid request expected');}return undefined;},{OPENAI_API_KEY:''}));
 const response=await handler(request(payload));assert.equal(response.status,200);const body=await response.json();
 assert.equal(body.data.assessment.engine,'curated_rules_v1');assert.equal(body.data.ai_review.reason,'not_configured');assert.equal(body.data.ai_review.is_ai_generated,false);assert.equal(calls,0);
});
test('AI request projects structured data, suppresses identifiers/raw text, bounds output, and disables response storage',async()=>{
 let calls=0;
 const result=await reviewAssessment(assessment,id,'Bearer session',deps(async(url,init)=>{
  if(!url.includes('api.openai.com'))return undefined;calls++;
  const raw=String(init!.body),body=JSON.parse(raw);
  for(const secret of ['PRIVATE USER TEXT','PRIVATE ERROR',id,'Bearer session','private-provider-key','serial_number','latitude','invoice'])assert.ok(!raw.includes(secret),secret);
  assert.equal(body.store,false);assert.equal(body.max_output_tokens,800);assert.equal(body.text.format.strict,true);assert.equal(body.text.format.type,'json_schema');
  assert.equal(body.model,'configured-test-model');assert.equal(init!.redirect,'error');assert.ok(init!.signal);
  assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer private-provider-key');
  return apiResult(ranking());
 }));
 assert.equal(calls,1);assert.equal(result.status,'reviewed');assert.equal(result.is_ai_generated,true);
 assert.deepEqual(result.ranked_candidates[0].evidence,[assessment.candidates[0].evidence[0]]);
 assert.deepEqual(result.ranked_candidates[0].source_ids,assessment.candidates[0].source_ids);
});
test('AI cannot introduce parts/advice, duplicate/drop candidates, or reference nonexistent evidence',()=>{
 const valid=ranking();assert.equal(validateRanking(valid,assessment).length,assessment.candidates.length);
 for(const bad of [
  {ranking:[]},
  {ranking:[{...valid.ranking[0],candidate_id:'replace-control-board'}]},
  {ranking:[{...valid.ranking[0],evidence_indexes:[999]}]},
  {ranking:[{...valid.ranking[0],evidence_indexes:[0,0]}]},
  {ranking:[{...valid.ranking[0],uncertainty:'confirmed'}]},
  {ranking:[{...valid.ranking[0],repair_instructions:'Open panel'}]},
  {...valid,summary:'New unsupported claim'},
 ])assert.throws(()=>validateRanking(bad,assessment));
});
test('hazards, unsupported products and incomplete answers skip AI without paid calls',async()=>{
 let calls=0;const d=deps(async()=>{calls++;throw new Error('No upstream expected');});
 for(const a of [assess(appliance,{...payload,symptoms:'Sparks at plug'}),assess({...appliance,model:'unknown'},payload),assess(appliance,{...payload,answers:{}})]){
  const result=await reviewAssessment(a,id,'Bearer session',d);assert.equal(result.status,'skipped');assert.equal(result.is_ai_generated,false);
 }
 assert.equal(calls,0);
});
test('provider refusal, incompleteness, errors and invalid JSON preserve useful unavailable states',async()=>{
 const cases:[()=>Response,string][]=[
  [()=>json({},429),'upstream_error'],
  [()=>json({status:'incomplete',output:[]}),'incomplete_response'],
  [()=>json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),'refused'],
  [()=>apiResult({ranking:[{candidate_id:'forged',evidence_indexes:[0],uncertainty:'needs_inspection'}]}),'invalid_response'],
  [()=>new Response('{bad'),'invalid_response'],
  [()=>json({status:'completed',output:[],padding:'x'.repeat(70000)}),'invalid_response'],
 ];
 for(const [upstream,reason] of cases){
  const handler=createHandler(deps(async url=>url.includes('api.openai.com')?upstream():undefined));
  const response=await handler(request(payload));assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.data.ai_review.reason,reason);assert.equal(body.data.ai_review.is_ai_generated,false);assert.ok(body.data.assessment.candidates.length>0);
 }
});
test('AI honors lookup cooldown and does not retry or call provider after rate limit',async()=>{
 let calls=0;const handler=createHandler(deps(async url=>{
  if(url.includes('/rpc/claim_support_lookup'))return json({code:'RP429'},400);
  if(url.includes('api.openai.com')){calls++;return apiResult(ranking());}return undefined;
 }));
 assert.equal((await handler(request(payload))).status,429);assert.equal(calls,0);
});
test('AI timeout returns explicit unavailable state',async()=>{
 const old=globalThis.setTimeout;
 globalThis.setTimeout=((fn:()=>void,ms:number,...args:unknown[])=>old(fn,ms===12000?1:ms,...args)) as typeof setTimeout;
 try{
  const result=await reviewAssessment(assessment,id,'Bearer session',deps(async(url,init)=>{
   if(!url.includes('api.openai.com'))return undefined;
   return new Promise((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));
  }));assert.equal(result.reason,'timeout');assert.equal(result.is_ai_generated,false);
 }finally{globalThis.setTimeout=old;}
});
