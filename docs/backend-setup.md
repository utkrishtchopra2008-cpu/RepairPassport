# RepairPassport backend setup and deployment

## Current state and project identity

Branch: `backend-mvp`. The initial GitHub main contained only README.md (`cdaa9b9`); no Supabase schema, Firebase config, build files, workflow or credentials were published. Earlier Firebase setup identifies **repairpassport-utkrisht** as the intended project; `.firebaserc` reuses that ID. Its expected default URL is https://repairpassport-utkrisht.web.app; a read-only check returned 404 before deployment. This is an expected target URL, **not a completed deployment**.

The existing Supabase project is `xhkjqtknjwxzbabnirsy` at https://xhkjqtknjwxzbabnirsy.supabase.co. Its publishable key is verified and listed in the backend contract. Email/password is enabled with email confirmation required. Read-only checks show the appliances API and passport function are not yet deployed. The TinyFish credential is stored only in the ignored, owner-readable local `supabase/.env`, with the manufacturer page left blank until approved. Project management access is not yet available here. Connect the existing Supabase/Firebase accounts or authenticate their CLIs locally; do not create replacement projects. Never paste a service-role key, TinyFish key, database password, Firebase CI token or Supabase access token in chat or commit one. No service-role credential is needed by the application functions.

Frontend owns `src/`, `public/`, `index.html`, root package/build config and workflows. Backend changes only `supabase/`, `firebase.json`, `.firebaserc`, and backend docs. Contract: [backend-contract.md](backend-contract.md). Frozen API is the integration source of truth.

## Local backend verification (no cloud access required)

Use Node 22+ (tested on Node 24):

```sh
npm ci --prefix supabase
npm test --prefix supabase
npm run typecheck --prefix supabase
```

Database tests execute the actual migration and PL/pgSQL functions in PGlite/PostgreSQL with pgcrypto. The test-only bootstrap supplies Auth roles/users and Storage tables; it also installs an intentionally broad legacy storage policy to prove restrictive guards win. Tests exercise owner isolation, immutable corrections, private file policies, explicit quote unknowns, restricted anonymous sharing, cooldowns, recipient/expiry validation, replay, and rollback of the entire transfer when event insertion fails. Edge tests use mocked external HTTP services; no TinyFish credits are consumed.

These checks do **not** replace a real Supabase Storage upload test, real Auth sign-in, concurrent cloud requests, deployed Deno checks, or a second-device frontend test. Never run `supabase/tests/bootstrap.sql` against a real project.

## Inspect and migrate the existing Supabase project

Install/login to the official Supabase CLI on the backend Mac. Run commands from the repository root. Set `SUPABASE_PROJECT_REF` to the **existing** project reference, and `SUPABASE_URL` to its matching HTTPS URL. Get browser-safe publishable/anon key from that project's API settings. Use the connected Supabase integration or Dashboard SQL editor to run `supabase/scripts/preflight.sql` first.

Stop on any name collision or existing table/bucket/function with different definitions. Inspect the current schema and migration history; reconcile additively. The migration intentionally fails rather than overwriting existing tables/bucket. If pgcrypto is already installed outside `extensions`, inspect that existing layout and agree on an additive migration adaptation rather than resetting/moving it blindly. Existing unrelated buckets/policies remain intact; restrictive policies constrain only `repair-documents`.

```sh
supabase login
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase migration list
supabase db push --dry-run
supabase db push
```

Read the dry run: this branch supplies exactly one new migration, `202611150001_repairpassport.sql`. Do not use `db reset`, `migration repair`, `--include-all`, `--include-seed` or create/replace resources to bypass drift. No seed is supplied. All migrations run in a transaction.

Seven application tables use RLS; authenticated clients get SELECT only (hash columns withheld). Protected writes use fixed-search-path security-definer functions with explicit grants, identity-derived attribution and appliance locks. Keep `rp_private` out of the exposed API schemas. Preserve the private bucket; do not enable public access.

## Deploy functions and secrets

Copy `supabase/.env.example` to ignored `supabase/.env` and fill the TinyFish key plus one coordinator-approved manufacturer support URL. `ALLOWED_ORIGINS` must list exact origins without trailing slashes, including the deployed Firebase site and optionally localhost. The file is local only. Functions use platform-provided `SUPABASE_URL` and `SUPABASE_ANON_KEY` and forward the verified user's JWT into RLS/RPC; they never use a service-role key.

```sh
supabase secrets set --env-file supabase/.env
supabase functions deploy passport --project-ref "$SUPABASE_PROJECT_REF"
supabase functions deploy support-lookup --project-ref "$SUPABASE_PROJECT_REF"
```

`verify_jwt=false` is intentional: buyer requests are anonymous, and function code verifies user sessions with Auth `/user` before any mutation/lookup. Do not remove that verification. The database also rejects anonymous mutation RPC calls. Origin checks run before processing. Non-browser API callers may omit Origin; CORS is not authentication.

TinyFish makes one Fetch request for one fixed page, no navigation agent, retries or user prompt. It sends neither serial numbers nor symptoms. It applies a 60-second per-appliance DB cooldown, 12-second upstream timeout, 256-KiB response cap and 12000-character returned-text cap. Returned source/final URL must match the approved page if present. TinyFish is a third-party renderer and may fetch page subresources/redirects internally; application code cannot enforce its internal browser egress. Do not use pages that redirect; unexpected returned final URLs are rejected. No live lookup is claimed until a real key/approved page test passes. `unavailable` is an intentional usable state.

## Authentication redirects

Enable email/password in the existing project; keep email confirmation and existing security settings. Set Site URL to the actual deployed Firebase origin and add that origin plus `/auth/callback` to Additional Redirect URLs. Preserve existing entries. The frontend must implement the callback and retain transfer tokens while signing in.

To update only these redirect settings through the Management API, set `SUPABASE_ACCESS_TOKEN` securely in the local shell along with matching `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, and `SITE_URL=https://repairpassport-utkrisht.web.app`, then run:

```sh
node supabase/scripts/configure-auth.mjs
```

This script inspects the current config, preserves old redirect entries and all unrelated provider/security settings, and changes only `site_url` and `uri_allow_list`. It never prints the full config or token. Do not push the local `config.toml` as a wholesale remote auth configuration replacement.

## Coordinator / frontend handoff

The confirmed **browser-safe** values are in the backend contract. Configure these names on the frontend and in its build environment:

```dotenv
VITE_SUPABASE_URL=https://<existing-project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<existing-publishable-or-anon-key>
```

Place them in the frontend Mac's local env using that build tool's conventions. Never put privileged credentials into `VITE_*` variables. If automatic GitHub builds are used, those browser-safe values must also be available at **build time**. Firebase Hosting does not inject React build variables at runtime. Existing workflow files are not yet in GitHub; frontend/coordinator must commit their existing workflow rather than create duplicate deployment pipelines blindly.

Frontend calls `functions.invoke('passport',{body:{action,payload}})` and checks both transport errors and `{data,error}` response. Use Supabase JS v2 Auth and direct owner-filtered reads. Required routes are `/auth/callback`, `/buyer#token=...`, `/transfer#token=...`. Buyer data comes only from `buyer_summary`; download private files with authenticated Storage download, never buyer URLs. Clear object URLs/local cached private data on logout or ownership change. Do not create signed URLs: Storage SELECT permission can technically allow a caller to mint one and it stays usable until expiry; the MVP client must use session-authorized downloads. Previously downloaded bytes cannot be recalled.

Comparison UI should show null fields as **Unknown**, zero as ₹0, amounts divided by 100, and all quote attribution as owner-reported. It should compare scope, never declare fraud/price fairness. Treat support response as plain untrusted reference text, never HTML or a diagnosis.

## Integrate committed frontend changes without crossing file ownership

Fetch the frontend's published branch/commit. Inspect its diff from main first. If it modifies backend-owned files, report the exact overlapping paths to that agent and resolve the backend side here; do not overwrite backend files. If it contains only frontend-owned files, merge its committed branch into `backend-mvp` and retain that commit ancestry. Do not cherry-pick arbitrary uncommitted files or edit the frontend to disguise a contract mismatch.

Before merging, report specific mismatch using: frontend file + line, current call/field, required contract call/field, impact. Backend changes to the frozen contract require an explicit coordinator note. `firebase.json` currently points to `dist`, a **pending Vite assumption**; if the committed root build uses `react-scripts`, change only backend-owned Hosting output to `build` after reporting the mismatch.

From the integrated repository root:

```sh
npm ci
npm run build
node supabase/scripts/check-integration.mjs
firebase login
firebase deploy --only hosting --project repairpassport-utkrisht
```

The check reads root build scripts, verifies output matches Hosting, confirms `index.html` exists and SPA rewrite is present. It refuses to pass when frontend is absent or build output is ambiguous. The backend branch does not invent a replacement UI. Merge/release through the existing main pipeline only after integration checks; user has authorized integration/deployment, no extra approval is needed for completing this scope. Avoid deploying both manually and through a pipeline at the same time.

## Two-account live acceptance check

Create/use two dedicated **confirmed** email/password test accounts in the intended project. Keep the credentials in local environment variables (never command history/chat). The smoke script does not create accounts or erase records. It leaves a clearly labelled appliance transferred to the recipient so history can be inspected.

Required environment: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `RP_OWNER_EMAIL`, `RP_OWNER_PASSWORD`, `RP_RECIPIENT_EMAIL`, `RP_RECIPIENT_PASSWORD`, `SITE_URL`.

```sh
node supabase/tests/live-smoke.mjs
```

It checks persistence after reauthentication, unrelated user reads/downloads, actual private upload, quote nulls, anonymous buyer API, deployed SPA fallback/CORS, recipient-bound transfer, one-time acceptance, revoked old share, old-owner denial, and surviving history. It also rejects direct ownership PATCH. It never prints access/share/transfer tokens, passwords or file contents.

Manual finish: refresh the frontend and check persistence; generate a buyer QR and scan from another physical device before transferring; sign in there as the intended recipient and accept; retry acceptance; verify old owner editing fails, old share stops working, new owner sees history but not original invoice. Check confirmation callback on the deployed origin. Record exact deployment URL, backend/integration commit and any remaining feature gaps. Automated anonymous API checks alone do not prove the second-device QR UI works.

## Contract clarification log

- v1 clarification: HTTP method misuse returns 405; external Auth/DB outages may return 502/503. Same `{error:{code,message}}` format; no schema/action/field changes. Frontend should display the safe message and allow retry. These statuses extend the original listed infrastructure error statuses.
- Firebase project resolved to existing `repairpassport-utkrisht` from earlier setup. Supabase project/public configuration is now confirmed in the contract. Build-output confirmation, management access and deployed-origin Auth changes remain pending.
