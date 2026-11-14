import { authenticate, cors, exactKeys, failure, invalid, jsonBody, method, object, response, rpc, token, type Dependencies } from '../_shared/http.ts';

const mutations = new Set([
  'appliance_create','appliance_update','event_append','document_create','request_create','request_close',
  'quote_create','share_create','share_revoke','transfer_invite','transfer_revoke','transfer_accept',
]);
export function createHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    let headers: Headers | undefined;
    try {
      headers=cors(req,deps.env);
      if (req.method==='OPTIONS') return new Response(null,{status:204,headers});
      method(req);
      const body=await jsonBody(req);
      exactKeys(body,['action','payload']);
      object(body.payload);
      if (body.action==='buyer_summary') {
        exactKeys(body.payload,['token']);
        // Buyer token validation deliberately maps invalid tokens to unavailable.
        try { token(body.payload.token); } catch {
          return new Response(JSON.stringify({error:{code:'NOT_FOUND',message:'Record or link unavailable'}}),{status:404,headers});
        }
        return response(await rpc('buyer_summary',{p_token:body.payload.token},null,deps),headers);
      }
      if (typeof body.action!=='string' || !mutations.has(body.action)) throw invalid('Unknown action');
      const authorization=await authenticate(req,deps);
      return response(await rpc('passport_mutate',{p_action:body.action,p_payload:body.payload},authorization,deps),headers);
    } catch(error) { return failure(error,headers); }
  };
}
if (import.meta.main) Deno.serve(createHandler({env:name=>Deno.env.get(name),fetch}));
