// Add exact redirect URLs to the existing project's Auth configuration. No provider/security settings are replaced.
const {SUPABASE_ACCESS_TOKEN:token,SUPABASE_PROJECT_REF:ref,SUPABASE_URL:url,SITE_URL:site}=process.env;
if(!token || !ref || !url || !site) throw new Error('Set SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_URL and SITE_URL securely in your shell');
if(!/^[a-z0-9]{20}$/.test(ref) || new URL(url).origin!==`https://${ref}.supabase.co`) throw new Error('Project reference and Supabase URL must match the existing project');
const origin=new URL(site);
if(origin.protocol!=='https:' || site!==origin.origin)throw new Error('SITE_URL must be an exact HTTPS deployment origin, with no trailing slash');
const endpoint=`https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
const current=await fetch(endpoint,{headers,signal:AbortSignal.timeout(15000)});
if(!current.ok)throw new Error(`Could not inspect existing Auth configuration (${current.status})`);
const existing=await current.json();
const previous=existing.uri_allow_list;
if(previous!=null && typeof previous!=='string')throw new Error('Unexpected Auth redirect configuration; inspect it before modifying');
const redirects=new Set((previous||'').split(',').map(v=>v.trim()).filter(Boolean));
redirects.add(site+'/auth/callback');
redirects.add('http://localhost:5173/auth/callback');
const patch={site_url:site,uri_allow_list:[...redirects].join(',')};
if(existing.site_url===patch.site_url && previous===patch.uri_allow_list){console.log('Existing Auth redirects already configured');process.exit(0);}
const update=await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify(patch),signal:AbortSignal.timeout(15000)});
if(!update.ok)throw new Error(`Auth configuration update failed (${update.status})`);
// Do not print full config: it can contain provider credentials.
console.log(`Updated Auth site URL to ${site}; preserved existing redirect entries and provider/security settings`);
