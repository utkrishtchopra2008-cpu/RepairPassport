import { authenticate, boundedText, cors, exactKeys, failure, jsonBody, method, object, response, rpc, uuid, type Dependencies } from '../_shared/http.ts';

// No URL, goal, serial number, symptom or prompt supplied by the caller reaches TinyFish.
const approvedHosts = new Set(['www.samsung.com','samsung.com','www.lg.com','lg.com','www.bosch-home.in','bosch-home.in']);
export function approvedSupportUrl(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const url=new URL(input);
    if (url.protocol!=='https:' || url.port || url.username || url.password || url.search || url.hash ||
        !approvedHosts.has(url.hostname) || !/(?:^|\/)(?:support|service|customer-service)(?:\/|$)/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
export function createHandler(deps: Dependencies) {
  return async(req: Request): Promise<Response> => {
    let headers: Headers | undefined;
    try {
      headers=cors(req,deps.env);
      if (req.method==='OPTIONS') return new Response(null,{status:204,headers});
      method(req);
      const body=await jsonBody(req);
      exactKeys(body,['appliance_id']); uuid(body.appliance_id);
      const authorization=await authenticate(req,deps);
      // Includes ownership check and serialized cooldown. No privileged database client.
      await rpc('claim_support_lookup',{p_appliance_id:body.appliance_id},authorization,deps);
      const source=approvedSupportUrl(deps.env('MANUFACTURER_SUPPORT_URL'));
      const key=deps.env('TINYFISH_API_KEY');
      const unavailable=(reason: string)=>response({status:'unavailable',reason,source_url:source},headers!);
      if (!source || !key) return unavailable('not_configured');
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),12000);
      try {
        const upstream=await deps.fetch('https://api.fetch.tinyfish.ai',{
          method:'POST',headers:{'Content-Type':'application/json','X-API-Key':key},
          body:JSON.stringify({urls:[source]}),signal:controller.signal,redirect:'error',
        });
        if (!upstream.ok) { await upstream.body?.cancel(); return unavailable('upstream_error'); }
        const parsed: unknown=JSON.parse(await boundedText(upstream,262144));
        object(parsed);
        if (!Array.isArray(parsed.results) || parsed.results.length!==1) return unavailable('invalid_response');
        const entry=parsed.results[0]; object(entry);
        // Reject unexpected source/final URL, redirects off the exact approved page, and error objects.
        if (entry.error || (entry.url && entry.url!==source) || (entry.final_url && entry.final_url!==source) || typeof entry.text!=='string' || !entry.text.trim()) return unavailable('invalid_response');
        return response({status:'found',source_url:source,content:entry.text.slice(0,12000)},headers!);
      } catch (error) {
        return unavailable(controller.signal.aborted ? 'timeout':error instanceof TypeError ? 'upstream_error':'invalid_response');
      } finally { clearTimeout(timeout); }
    } catch(error) { return failure(error,headers); }
  };
}
if (import.meta.main) Deno.serve(createHandler({env:name=>Deno.env.get(name),fetch}));
