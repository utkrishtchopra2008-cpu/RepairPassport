import assert from 'node:assert/strict';
assert.equal(process.env.SUPABASE_URL,'https://xhkjqtknjwxzbabnirsy.supabase.co');
const url=process.env.SUPABASE_URL+'/functions/v1/repair-assistant';
const result=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:process.env.SITE_URL,apikey:process.env.SUPABASE_PUBLISHABLE_KEY},body:JSON.stringify({action:'list_products',payload:{}}),redirect:'error',signal:AbortSignal.timeout(20000)});
assert.equal(result.status,200,'Public catalogue endpoint failed after deployment');
assert.equal(result.headers.get('access-control-allow-origin'),process.env.SITE_URL,'Deployed CORS does not match site');
const body=await result.json();assert.equal(body.data?.products?.[0]?.full_model,'WW80T504DAN1TL');
console.log('Public component catalogue and deployed CORS verified. Two-account and frontend acceptance tests still need to be run.');
