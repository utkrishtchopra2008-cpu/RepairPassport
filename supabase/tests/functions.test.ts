import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as passport } from '../functions/passport/index.ts';
import { createHandler as lookup, approvedSupportUrl } from '../functions/support-lookup/index.ts';
import type { Dependencies } from '../functions/_shared/http.ts';

const id='11111111-1111-4111-8111-111111111111';
const token='a'.repeat(64);
const support='https://www.samsung.com/in/support/';
const vars: Record<string,string>={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-anon',ALLOWED_ORIGINS:'https://repair.example,http://localhost:5173',TINYFISH_API_KEY:'server-only-secret',MANUFACTURER_SUPPORT_URL:support};
function request(body: unknown, options: {origin?:string,auth?:boolean,method?:string}={}) {
 const headers:Record<string,string>={'Content-Type':'application/json',Origin:options.origin??'https://repair.example'};
 if(options.auth!==false) headers.Authorization='Bearer user-session';
 return new Request('https://example.supabase.co/functions/v1/passport',{method:options.method??'POST',headers,...(options.method==='OPTIONS'||options.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
}
function deps(handler: (url:string,init?:RequestInit)=>Promise<Response>, overrides:Record<string,string>={}):Dependencies {
 return {env:name=>({...vars,...overrides})[name],fetch:async(input,init)=>handler(String(input),init)};
}
const json=(value: unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function backend(url:string) {
 if(url.endsWith('/auth/v1/user')) return Promise.resolve(json({id}));
 return Promise.resolve(json({id}));
}

test('CORS is exact, preflight succeeds and denied origin never calls backend',async()=>{
 let calls=0;
 const handler=passport(deps(async()=>{calls++;return json({id});}));
 const denied=await handler(request({action:'appliance_create',payload:{}},{origin:'https://repair.example.evil.test'}));
 assert.equal(denied.status,403); assert.equal(calls,0); assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
 const preflight=await handler(request(null,{method:'OPTIONS'}));
 assert.equal(preflight.status,204);assert.equal(calls,0);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://repair.example');
 assert.ok(preflight.headers.get('Access-Control-Allow-Headers')?.includes('authorization'));
});
test('body validation blocks oversized, malformed and unexpected envelopes without backend calls',async()=>{
 let calls=0;const handler=passport(deps(async()=>{calls++;return json({id});}));
 for(const body of ['{bad',JSON.stringify({action:'appliance_create',payload:{x:'a'.repeat(17000)}}),JSON.stringify({action:'appliance_create',payload:{},owner_id:id}),JSON.stringify({action:'unknown',payload:{}}),JSON.stringify({action:'appliance_create',payload:[]})]) {
  assert.equal((await handler(request(body))).status,400);
 }
 assert.equal((await handler(request(null,{method:'GET'}))).status,405);
 assert.equal(calls,0);
});
test('mutations require a verified session; publishable key alone is not identity',async()=>{
 let calls=0;const handler=passport(deps(async()=>{calls++;return json({id});}));
 assert.equal((await handler(request({action:'appliance_create',payload:{}},{auth:false}))).status,401);assert.equal(calls,0);
 const expired=passport(deps(async()=>json({message:'invalid'},401)));
 assert.equal((await expired(request({action:'appliance_create',payload:{}}))).status,401);
});
test('mutations forward caller JWT, never a service role, and wrap results consistently',async()=>{
 const calls:Array<{url:string,init?:RequestInit}>=[];
 const handler=passport(deps(async(url,init)=>{calls.push({url,init});return backend(url);}));
 const result=await handler(request({action:'appliance_create',payload:{brand:'LG',model:'WM-1'}}));
 assert.deepEqual(await result.json(),{data:{id}});assert.equal(calls.length,2);
 const headers=calls[1].init!.headers as Record<string,string>;
 assert.equal(headers.Authorization,'Bearer user-session');assert.equal(headers.apikey,'public-anon');
 assert.deepEqual(JSON.parse(String(calls[1].init!.body)),{p_action:'appliance_create',p_payload:{brand:'LG',model:'WM-1'}});
});
test('anonymous buyer action has no getUser call and strips unrelated user session',async()=>{
 const calls:string[]=[];
 const handler=passport(deps(async(url,init)=>{calls.push(url);assert.equal((init!.headers as Record<string,string>).Authorization,undefined);return json({appliance:{brand:'LG'}});}));
 const result=await handler(request({action:'buyer_summary',payload:{token}},{auth:false}));
 assert.equal(result.status,200);assert.deepEqual(calls,['https://example.supabase.co/rest/v1/rpc/buyer_summary']);
 assert.equal((await handler(request({action:'buyer_summary',payload:{token:'bad'}}))).status,404);
});
test('database error codes map to stable safe errors without leaking SQL or credentials',async()=>{
 for(const [dbcode,status,code] of [['RP400',400,'INVALID_INPUT'],['RP403',403,'FORBIDDEN'],['RP404',404,'NOT_FOUND'],['RP409',409,'CONFLICT'],['RP410',410,'EXPIRED'],['RP429',429,'RATE_LIMITED'],['42501',403,'FORBIDDEN'],['XX000',500,'INTERNAL_ERROR']] as const){
  const handler=passport(deps(async url=>url.endsWith('/auth/v1/user')?json({id}):json({code:dbcode,message:'sensitive SQL internal details',hint:'server-only-secret'},400)));
  const result=await handler(request({action:'transfer_accept',payload:{token}}));
  assert.equal(result.status,status);const body=await result.json();assert.equal(body.error.code,code);assert.ok(!JSON.stringify(body).includes('sensitive'));assert.ok(!JSON.stringify(body).includes('secret'));
 }
});
test('support URL allowlist rejects arbitrary hosts, credentials, ports, query and non-support paths',()=>{
 assert.equal(approvedSupportUrl(support),support);
 for(const value of ['http://www.samsung.com/in/support/','https://www.samsung.com.evil.test/support/','https://127.0.0.1/support/','https://user:password@www.samsung.com/support/','https://www.samsung.com:8443/support/','https://www.samsung.com/support/?url=https://evil.test','https://www.samsung.com/support/#bad','https://www.samsung.com/shop/']) assert.equal(approvedSupportUrl(value),null);
});
test('support lookup makes exactly one bounded TinyFish fetch with fixed server page and no user data',async()=>{
 const calls:Array<{url:string,init?:RequestInit}>=[];
 const handler=lookup(deps(async(url,init)=>{calls.push({url,init});if(url==='https://api.fetch.tinyfish.ai') return json({results:[{url:support,final_url:support,text:'Manufacturer support content'}]});return backend(url);}));
 const result=await handler(request({appliance_id:id}));
 assert.deepEqual(await result.json(),{data:{status:'found',source_url:support,content:'Manufacturer support content'}});
 const upstream=calls.filter(c=>c.url==='https://api.fetch.tinyfish.ai');assert.equal(upstream.length,1);
 assert.deepEqual(JSON.parse(String(upstream[0].init!.body)),{urls:[support]});
 assert.equal((upstream[0].init!.headers as Record<string,string>)['X-API-Key'],'server-only-secret');
 assert.equal(upstream[0].init!.redirect,'error');assert.ok(upstream[0].init!.signal);
 assert.equal((await handler(request({appliance_id:id,url:'https://evil.test'}))).status,400);
});
test('support lookup handles missing key, rate limit, timeout, upstream failure and oversized/redirected responses',async()=>{
 let tinyCalls=0;
 const missing=lookup(deps(async url=>{if(url.includes('tinyfish'))tinyCalls++;return backend(url);},{TINYFISH_API_KEY:''}));
 assert.equal((await (await missing(request({appliance_id:id}))).json()).data.reason,'not_configured');assert.equal(tinyCalls,0);
 const rate=lookup(deps(async url=>url.endsWith('/auth/v1/user')?json({id}):json({code:'RP429'},400)));
 assert.equal((await rate(request({appliance_id:id}))).status,429);
 for(const [upstream,reason] of [
  [()=>json({},503),'upstream_error'],
  [()=>json({results:[{text:'x',url:support,final_url:'https://evil.test'}]}),'invalid_response'],
  [()=>json({results:[{text:'a'.repeat(270000)}]}),'invalid_response'],
  [()=>json({results:[]}), 'invalid_response'],
 ] as const){
  const handler=lookup(deps(async url=>url.includes('tinyfish')?upstream():backend(url)));
  const result=await handler(request({appliance_id:id}));assert.equal(result.status,200);assert.equal((await result.json()).data.reason,reason);
 }
 const long=lookup(deps(async url=>url.includes('tinyfish')?json({results:[{text:'a'.repeat(15000)}]}):backend(url)));
 assert.equal((await (await long(request({appliance_id:id}))).json()).data.content.length,12000);
 // Exercise actual abort path without a 12-second wall-clock wait.
 const oldSetTimeout=globalThis.setTimeout;
 globalThis.setTimeout=((fn:()=>void,ms:number,...args:unknown[])=>oldSetTimeout(fn,ms===12000?1:ms,...args)) as typeof setTimeout;
 try{
  const timeout=lookup(deps(async(url,init)=>{
   if(!url.includes('tinyfish')) return backend(url);
   return new Promise((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }));
  assert.equal((await (await timeout(request({appliance_id:id}))).json()).data.reason,'timeout');
 }finally{globalThis.setTimeout=oldSetTimeout;}
});
