export type Env = (name: string) => string | undefined;
export type Fetch = typeof fetch;
export type Dependencies = { env: Env; fetch: Fetch };
export type ObjectValue = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const invalid = (message = 'Invalid request') => new ApiError(400, 'INVALID_INPUT', message);
export function object(value: unknown): asserts value is ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a JSON object');
}
export function exactKeys(value: ObjectValue, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw invalid('Missing or unexpected fields');
  }
}
export function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid('Valid UUID required');
}
export function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid('Invalid token');
}
export async function boundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximum) { await response.body?.cancel(); throw invalid('Response too large'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw invalid('Response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', {fatal:true}).decode(all);
}
export async function jsonBody(req: Request): Promise<ObjectValue> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw invalid('Content-Type must be application/json');
  let parsed: unknown;
  try {
    const body = new Response(req.body, {headers: req.headers});
    parsed = JSON.parse(await boundedText(body, 16384));
  } catch { throw invalid('Expected JSON body under 16 KiB'); }
  object(parsed);
  return parsed;
}
export function cors(req: Request, env: Env): Headers {
  const headers = new Headers({
    'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin',
    'Referrer-Policy':'no-referrer', 'X-Content-Type-Options':'nosniff',
  });
  const origin = req.headers.get('origin');
  const allowed = (env('ALLOWED_ORIGINS') || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (origin) {
    if (!allowed.includes(origin)) throw new ApiError(403, 'FORBIDDEN', 'Origin is not allowed');
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Allow-Methods','POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers','authorization, x-client-info, apikey, content-type, x-supabase-api-version');
    headers.set('Access-Control-Max-Age','600');
  }
  return headers;
}
export function response(data: unknown, headers: Headers) { return new Response(JSON.stringify({data}), {status:200,headers}); }
export function failure(error: unknown, headers?: Headers): Response {
  const safe = error instanceof ApiError ? error : new ApiError(500,'INTERNAL_ERROR','Request could not be completed');
  const resultHeaders = headers || new Headers({'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'});
  return new Response(JSON.stringify({error:{code:safe.code,message:safe.message}}),{status:safe.status,headers:resultHeaders});
}
export function method(req: Request) {
  if (req.method !== 'POST') throw new ApiError(405,'INVALID_INPUT','Use POST');
}
function config(env: Env) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_ANON_KEY');
  if (!url || !key) throw new ApiError(500,'INTERNAL_ERROR','Backend configuration unavailable');
  return {url: url.replace(/\/$/,''),key};
}
export async function authenticate(req: Request, deps: Dependencies): Promise<string> {
  const authorization = req.headers.get('authorization');
  if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) throw new ApiError(401,'UNAUTHENTICATED','Sign in required');
  const {url,key} = config(deps.env);
  let result: Response;
  try {
    result = await deps.fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:authorization},signal:AbortSignal.timeout(8000),redirect:'error'});
  } catch { throw new ApiError(503,'INTERNAL_ERROR','Authentication service unavailable'); }
  if (!result.ok) {
    await result.body?.cancel();
    if (result.status === 401 || result.status === 403) throw new ApiError(401,'UNAUTHENTICATED','Session expired or invalid');
    throw new ApiError(503,'INTERNAL_ERROR','Authentication service unavailable');
  }
  let user: ObjectValue;
  try { user=JSON.parse(await boundedText(result,65536)); object(user); }
  catch { throw new ApiError(503,'INTERNAL_ERROR','Authentication service unavailable'); }
  if (typeof user.id !== 'string') throw new ApiError(401,'UNAUTHENTICATED','Session expired or invalid');
  return authorization;
}
const errors: Record<string,[number,string,string]> = {
  RP400:[400,'INVALID_INPUT','Invalid field value'], RP401:[401,'UNAUTHENTICATED','Sign in required'],
  RP403:[403,'FORBIDDEN','Action not permitted'], RP404:[404,'NOT_FOUND','Record or link unavailable'],
  RP409:[409,'CONFLICT','Record conflicts with current state'], RP410:[410,'EXPIRED','Invitation expired'],
  RP429:[429,'RATE_LIMITED','Wait 60 seconds before another lookup'], '42501':[403,'FORBIDDEN','Action not permitted'],
  '22P02':[400,'INVALID_INPUT','Invalid field value'], '23514':[400,'INVALID_INPUT','Invalid field value'],
};
export async function rpc(name: string, args: ObjectValue, authorization: string | null, deps: Dependencies): Promise<unknown> {
  const {url,key} = config(deps.env);
  const headers: Record<string,string> = {apikey:key,'Content-Type':'application/json'};
  if (authorization) headers.Authorization=authorization;
  let result: Response;
  try {
    result=await deps.fetch(`${url}/rest/v1/rpc/${name}`, {method:'POST',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(8000),redirect:'error'});
  } catch { throw new ApiError(503,'INTERNAL_ERROR','Database service unavailable'); }
  let data: unknown;
  try { data=JSON.parse(await boundedText(result,1048576)); }
  catch { throw new ApiError(502,'INTERNAL_ERROR','Database service returned an invalid response'); }
  if (!result.ok) {
    const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
    const mapped=errors[code];
    if (mapped) throw new ApiError(...mapped);
    if (result.status===401) throw new ApiError(401,'UNAUTHENTICATED','Session expired or invalid');
    throw new ApiError(500,'INTERNAL_ERROR','Database operation failed');
  }
  return data;
}
