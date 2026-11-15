# RepairPassport backend contract — v1

Frozen integration contract for `backend-mvp`. Any change requires an explicit note to the frontend coordinator. Initial repository inspection: only README.md on main (`cdaa9b9`); no Firebase/Supabase project configuration or frontend build files. Existing project IDs/keys must be supplied, never guessed or replaced.

## Frontend configuration

For Vite React, use `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` with `createClient(url, key)`. These two values are browser-safe. The existing project was confirmed with a successful read of its Auth settings; use the following build-time configuration: Do not use a service-role/secret key in the browser. If the frontend uses another build tool, report it before adapting names. Firebase Hosting serves the build; no Firebase SDK is needed for authentication.

```dotenv
VITE_SUPABASE_URL=https://xhkjqtknjwxzbabnirsy.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_GMzffjY8O-TMFye4RtLJmQ_WjsOO2Yc
```

Existing Supabase project reference: `xhkjqtknjwxzbabnirsy`. Email/password is enabled; email confirmation is required. Read-only deployment checks returned `PGRST205` for `appliances` and 404 for `passport`; migrations/functions still need deployment using project management access. These checks did not read private records or modify the database.

Required client routes: `/buyer#token=<64 hex characters>` and `/transfer#token=<64 hex characters>`. Read token from URL fragment (not query string); remove it from browser history after retaining it in memory/sessionStorage. Never log tokens. Buyer link needs no login; transfer needs the intended recipient signed in with confirmed email. Preserve invitation across login. URLs are composed by the frontend using `window.location.origin`. Transfers are handed to the recipient by the owner; backend does not send email.

## Data conventions

All IDs are UUIDs, timestamps are ISO-8601 UTC (`timestamptz`), dates are `YYYY-MM-DD`. `!` means NOT NULL, `?` means nullable. IDs/time/author/ownership/attribution are server assigned. Money is integer **INR paise**, never rupees/floats; `null` means unknown, `0` means explicitly free. Limit each amount to 0–100000000 paise. Text limits: brand/model 100, nickname 120, serial 120, title 160, description/symptoms/exclusions 2000, provider/part 160. Never interpolate these strings as HTML.

## Exact tables

`auth.users(id)` is managed by Supabase Auth. No profile table. All FK references below use `ON DELETE RESTRICT`; no client deletes.

| Table | Columns (SQL type; required/nullable) |
|---|---|
| appliances | `id uuid ! PK`, `owner_id uuid ! FK auth.users`, `created_by uuid ! FK auth.users`, `brand text !`, `model text !`, `category text ! DEFAULT 'washing_machine' CHECK = 'washing_machine'`, `nickname text ?`, `serial_number text ?`, `purchase_date date ?`, `warranty_until date ?`, `created_at timestamptz ! DEFAULT now()`, `support_lookup_at timestamptz ?` |
| service_events | `id uuid ! PK`, `appliance_id uuid ! FK appliances`, `author_id uuid ! FK auth.users`, `event_type text !`, `title text !`, `description text ?`, `occurred_on date !`, `cost_minor bigint ?`, `currency text ! DEFAULT 'INR' CHECK = 'INR'`, `corrects_event_id uuid ? FK service_events`, `attribution text ! DEFAULT 'owner_reported' CHECK = 'owner_reported'`, `created_at timestamptz ! DEFAULT now()` |
| documents | `id uuid ! PK`, `appliance_id uuid ! FK appliances`, `uploaded_by uuid ! FK auth.users`, `kind text !`, `object_path text ! UNIQUE`, `content_type text !`, `byte_size integer !`, `created_at timestamptz ! DEFAULT now()` |
| repair_requests | `id uuid ! PK`, `appliance_id uuid ! FK appliances`, `author_id uuid ! FK auth.users`, `symptoms text !`, `error_code text ?`, `status text ! DEFAULT 'open'`, `created_at timestamptz ! DEFAULT now()` |
| quotes | `id uuid ! PK`, `repair_request_id uuid ! FK repair_requests`, `author_id uuid ! FK auth.users`, `provider_label text ?`, `part_description text ?`, `parts_cost_minor bigint ?`, `labor_cost_minor bigint ?`, `visit_cost_minor bigint ?`, `tax_cost_minor bigint ?`, `total_cost_minor bigint ?`, `warranty_days integer ?`, `exclusions text ?`, `currency text ! DEFAULT 'INR' CHECK = 'INR'`, `status text ! DEFAULT 'recorded' CHECK = 'recorded'`, `created_at timestamptz ! DEFAULT now()` |
| share_links | `id uuid ! PK`, `appliance_id uuid ! FK appliances`, `created_by uuid ! FK auth.users`, `token_hash text ! UNIQUE`, `expires_at timestamptz !`, `revoked_at timestamptz ?`, `created_at timestamptz ! DEFAULT now()` |
| transfers | `id uuid ! PK`, `appliance_id uuid ! FK appliances`, `from_owner_id uuid ! FK auth.users`, `recipient_email text !`, `token_hash text ! UNIQUE`, `status text ! DEFAULT 'pending'`, `expires_at timestamptz !`, `accepted_by uuid ? FK auth.users`, `accepted_at timestamptz ?`, `created_at timestamptz ! DEFAULT now()` |

Status/enums: `service_events.event_type`: `repair`, `maintenance`, `correction`, `transfer` (transfer server-only). Corrections must reference an event on the same appliance; only the original author may correct it, while still current owner. Original rows remain unchanged; frontend marks the referenced entry corrected and displays the new entry. Only one immediate correction per original; a correction can itself be corrected. `documents.kind`: `invoice`, `photo`. MIME: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`; size 1–10485760 bytes. `repair_requests.status`: `open`, `closed`. `transfers.status`: `pending`, `accepted`, `revoked`; expired is derived from `expires_at`, not a stored status. Quote status `recorded` means owner-entered, never technician-verified. No provider onboarding.

## Auth and direct reads

Use Supabase JS v2 `auth.signUp({email,password,options:{emailRedirectTo: origin + '/auth/callback'}})`, `auth.signInWithPassword({email,password})`, `auth.getSession()`, `auth.onAuthStateChange(...)`, and `auth.signOut()`. Sign-up may require confirmation before a session exists. Auth redirects must include the deployed origin + `/auth/callback`; frontend owns that route.

Authenticated direct reads (`.from(table).select(...)`):

- `appliances`: current owner only; `.select('*').order('created_at',{ascending:false})`; detail `.eq('id',id).single()`.
- `service_events`: all history of a currently owned appliance, ordered `occurred_on`, then `created_at`. Use `.eq('appliance_id',id)`. Free-text history is private to current owner, never returned to buyers.
- `documents`: current owner **and** original uploader must both match caller. Old documents are not handed to new owners.
- `repair_requests` and `quotes`: current owner **and** original author must match caller. New owners create new problem reports.
- `share_links`: only current owner and creator; select **only** `id,appliance_id,created_by,expires_at,revoked_at,created_at` (`token_hash` is not granted).
- `transfers`: only current owner and sender; select **only** `id,appliance_id,from_owner_id,recipient_email,status,expires_at,accepted_by,accepted_at,created_at` (`token_hash` is not granted). Recipient acceptance uses token, not table reads.

All application table writes go through the functions below; direct insert/update/delete is denied. RLS also applies to reads. Forbidden reads return empty arrays/not-found; don't infer ownership from user-supplied IDs.

## Mutations and buyer reads: Edge Function `passport`

Call `supabase.functions.invoke('passport', {body:{action, payload}})`. Authenticated callers send their session JWT (supabase-js handles this). Only `buyer_summary` is anonymous; publishable key is not a user identity.

Success HTTP 200: `{ "data": <result> }`. Error: `{ "error": { "code": "INVALID_INPUT|UNAUTHENTICATED|FORBIDDEN|NOT_FOUND|CONFLICT|EXPIRED|RATE_LIMITED|INTERNAL_ERROR", "message": "safe text" } }` with HTTP 400/401/403/404/409/410/429/500. CORS rejection is HTTP 403. All payloads are objects, UUID inputs must be valid, unknown fields are rejected. Client must also handle Supabase transport/network errors (including FunctionsHttpError and inspect its response JSON). Maximum JSON body 16 KiB.

| action | Exact payload | result (`data`) |
|---|---|---|
| `appliance_create` | `{brand,model,nickname?,serial_number?,purchase_date?,warranty_until?}` | appliance row |
| `appliance_update` | `{appliance_id,brand?,model?,nickname?,serial_number?,purchase_date?,warranty_until?}`; optional nullable values may explicitly be null; brand/model non-null | appliance row |
| `event_append` | `{appliance_id,event_type:'repair'|'maintenance'|'correction',title,description?,occurred_on,cost_minor?,corrects_event_id?}` | service_event row; `corrects_event_id` required/non-null exactly when type is correction |
| `document_create` | `{appliance_id,kind,content_type,byte_size}` | document row; reserves immutable upload path |
| `request_create` | `{appliance_id,symptoms,error_code?}` | repair_request row |
| `request_close` | `{repair_request_id}` | repair_request row |
| `quote_create` | `{repair_request_id,provider_label,part_description,parts_cost_minor,labor_cost_minor,visit_cost_minor,tax_cost_minor,total_cost_minor,warranty_days,exclusions}` | quote row; **all fields required**, use explicit null for unknown values; warranty 0–3650 days |
| `share_create` | `{appliance_id,expires_in_hours?}` integer 1–168, default 24 | `{id,token,expires_at}`; token shown once |
| `share_revoke` | `{share_link_id}` | `{id,revoked_at}`; idempotent |
| `buyer_summary` | `{token}` | restricted summary below; expired/revoked/invalid all return NOT_FOUND |
| `transfer_invite` | `{appliance_id,recipient_email,expires_in_hours?}` integer 1–72, default 24; email case-insensitive | `{id,token,recipient_email,expires_at}`; token shown once, previous pending invitations revoked |
| `transfer_revoke` | `{transfer_id}` | `{id,status:'revoked'}`; accepted invitation gives CONFLICT |
| `transfer_accept` | `{token}` | `{id,appliance_id,status:'accepted',accepted_at}`; email must match current confirmed `auth.users.email`; replay CONFLICT |

SQL RPC equivalents exist for testing/clients: `supabase.rpc('passport_mutate',{p_action:action,p_payload:payload})` for all authenticated mutations; `supabase.rpc('buyer_summary',{p_token:token})` for anonymous buyer access. RPC result is the inner `data`, not an envelope. RPC errors use PostgreSQL codes `RP400`, `RP401`, `RP403`, `RP404`, `RP409`, `RP410`, `RP429` mapped to the Edge errors above. Permission errors (`42501`) become FORBIDDEN. JSON/constraint failures become INVALID_INPUT. Never trust client-supplied authorship/owner/attribution. Transfer atomicity is in Postgres, not a chain of browser updates.

Buyer summary shape:

```json
{
  "appliance": {"brand":"Example","model":"WM-1","category":"washing_machine"},
  "events": [{"id":"uuid","event_type":"repair","occurred_on":"2026-11-15","cost_minor":150000,"currency":"INR","corrects_event_id":null,"attribution":"owner_reported"}],
  "history_notice":"Owner-reported records; absence of records does not mean absence of repairs."
}
```

Buyer events ordered `occurred_on`, `created_at`; maximum 1000 most recent records. Does not include appliance ID, serial, nickname, dates of purchase/warranty, user IDs, email, free text, documents, object paths, repair requests, quotes or invitation details. Monetary history is owner-reported, not verified. No original invoice/photo is ever in a buyer response. The buyer route must not fetch private tables/documents. Render a QR encoding the buyer URL; it must work without the owner's session.

## Private uploads

1. Call `document_create`; it returns `id,object_path,...`.
2. `supabase.storage.from('repair-documents').upload(document.object_path, file, {contentType:file.type,upsert:false})`. Path is server-assigned `<uploader UUID>/<appliance UUID>/<document UUID>`; no user filenames/PII. Metadata reservation may remain after a failed upload; retry same path, never overwrite.
3. Use `.download(object_path)` under the authenticated session, then display a temporary browser object URL; revoke it on close/logout. **Do not create signed/public URLs**: signed URLs can outlive ownership changes. Bucket is private; storage SELECT/INSERT policies require current appliance ownership and uploader identity; no client UPDATE/DELETE. Actual MIME/size must match reservation. Metadata reservation alone is not evidence a file uploaded. Do not render uploaded HTML/SVG; allowed MIME is restricted.

## Manufacturer lookup: Edge Function `support-lookup`

Authenticated POST via `.functions.invoke('support-lookup',{body:{appliance_id}})`. No URL, prompt, model or credential accepted from browser. Confirms ownership and atomically claims a 60-second per-appliance cooldown (RPC `claim_support_lookup(p_appliance_id)` returns `{brand,model}`). One TinyFish Fetch call, no retries, exact server-approved HTTPS manufacturer support page; timeout 12 seconds; response capped at 256 KiB and returned text at 12000 characters. Browser receives no key. Content is untrusted manufacturer-page reference text, never diagnosis, pricing or automatic manual matching. UI must render as plain text and label it accordingly.

HTTP 200 `{data:{status:'found',source_url,content}}` or `{data:{status:'unavailable',reason:'not_configured'|'timeout'|'upstream_error'|'invalid_response',source_url:null|string}}`. Auth/validation/rate errors use the same error envelope/status as passport. Unavailable must not block core flows. Server secrets: `TINYFISH_API_KEY`, `MANUFACTURER_SUPPORT_URL` (exact approved URL), `ALLOWED_ORIGINS` (comma-separated exact deployment/local origins). Approved manufacturer hostname/path checks are implemented server-side; no arbitrary destination. There is no lookup history table or background polling.

## Transfer invariants

Appliance row is locked before invitations/mutations/acceptance. Acceptance validates pending status, expiry, current sender ownership, recipient confirmed email and different recipient identity. A single transaction changes owner, marks invitation accepted, appends a generic transfer event, revokes all buyer links and other invitations. Original history stays; previous owner loses all appliance editing and document access immediately. New owner receives history, never prior owner's original documents/quotes. Invitation/claim endpoints reject replay; invitation is distinct from share link. Transfer/share tokens are random 256-bit secrets, only SHA-256 hashes stored.

## Coordinator status

Supabase browser-safe values are confirmed above. Supabase/Firebase management access, verified deployed origin, Firebase build output, frontend commit and manufacturer page are pending. No deployment or live two-account verification claimed. `firebase.json` will target `dist` only if frontend confirms Vite; otherwise update hosting output explicitly with coordinator agreement. No resource creation/reset is authorized or necessary. Backend setup and executable security checks live under `supabase/` and `docs/backend-setup.md`.

## Explicit v1 integration clarification (2026-11-15)

Firebase project has been recovered from the earlier setup as `repairpassport-utkrisht` and `.firebaserc` now reuses it. Its expected URL is `https://repairpassport-utkrisht.web.app`; not yet deployed. Supabase browser-safe values are now confirmed above; management access is still pending. Hosting output `dist` still needs frontend build confirmation. HTTP 405 covers method misuse; infrastructure outages can return 502/503 with the same `INTERNAL_ERROR` envelope. No table, action, field or response shape changed. Storage policy accommodates pre-upload MIME/contentLength probes and validates supplied final MIME/size; the client upload sequence is unchanged.
