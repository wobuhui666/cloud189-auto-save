# HDHive API Lab

Standalone API notes and TypeScript scaffolding for HDHive. This folder is intentionally not wired into the parent project.

## What is implemented

- Generic `HdhiveClient` with cookie jar, CSRF header injection, JSON parsing, and auth-refresh retry shape.
- Endpoint constants for the observed public, auth, `/go-api`, and customer routes.
- Server Action payload builders for the observed login, TMDB proxy, and resource unlock shapes.
- Signed request helper interfaces that document HDHive's WASM signing boundary without bypassing it.
- CLI probes for safe public requests and endpoint-shape inspection.

## What is not implemented

- No credential submission.
- No automatic login.
- No signer bypass or reimplementation of HDHive's production WASM module.
- No integration into `src/`, `frontend/`, or the existing app.

## Build

```bash
cd hdhive-api-lab
npm install
npm run build
```

In this repository, the parent `node_modules` may already satisfy `typescript`, so this also works from the repo root:

```bash
npx tsc -p hdhive-api-lab/tsconfig.json
```

## Safe probes

```bash
node hdhive-api-lab/dist/cli.js time
node hdhive-api-lab/dist/cli.js probe /api/public/security/time
node hdhive-api-lab/dist/cli.js shapes
```

Optional environment variables:

```bash
HDHIVE_BASE_URL=https://hdhive.com
HDHIVE_COOKIE='name=value; csrf_access_token=...'
HDHIVE_CSRF_TOKEN='...'
```

Do not commit real cookies, tokens, email addresses, or passwords.

## Minimal usage

```ts
import { HdhiveClient, SECURITY_ENDPOINTS } from "./src";

const client = new HdhiveClient();
const response = await client.get(SECURITY_ENDPOINTS.time);
console.log(response.data);
```

## Signed paths

Most `/go-api/*` and `/api/customer/*` calls require the browser WASM signed channel. See `docs/reverse-notes.md` and `src/signedChannel.ts` for the exact observed header flow and the signer interface.

## Resource unlock shape

Observed resource pages use a Next.js Server Action for unlock:

```http
POST /resource/189/<resourceSlug>
Next-Action: 601a2054beb3034dd490287f5aa0d7c801f9e650c7
Accept: text/x-component
Content-Type: text/plain;charset=UTF-8

["<resourceSlug>","$T"]
```

The action id can rotate between deployments. Rediscover it from the live page before automating. The RSC response renders the final cloud share URL in the page DOM.
