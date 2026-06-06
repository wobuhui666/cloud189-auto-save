# HDHive reverse notes

Scope: standalone notes and client scaffolding only. Nothing here is integrated into the parent project.

## Static bundle evidence

- Site: `https://hdhive.com`
- Framework: Next.js app router.
- Main API adapter bundle: `/_next/static/chunks/1826-6e52327038b48ee6.js`
- Search shell bundle: `/_next/static/chunks/app/layout-53c339a4aecf04ba.js`
- Login page bundle: `/_next/static/chunks/app/(auth)/login/page-60d9bd45b280ee7c.js`

## Request adapter behavior

The browser bundle creates an axios instance with a custom fetch adapter:

- `withCredentials: true`
- Adds `X-CSRF-TOKEN` from cookie `csrf_access_token`
- Parses JSON for default responses
- For non-GET success responses, returns `{ response: data }`
- On 401, attempts `/api/public/auth/refresh` once unless the request is auth-related or marked with `x-skip-auth-refresh`
- Removes `csrf_access_token` and redirects to `/login?redirect=...` if refresh fails in browser

Observed unsigned prefixes from the bundle:

- `/api/public/security/session/handshake`
- `/api/public/security/session/refresh`
- `/api/public/security/decoy`
- `/api/public/security/time`
- `/api/open/`
- `/api/public/auth/`
- `/api/public/auth/telegram/`
- `/api/miniapp/`

All other `/api/*` paths are routed through the signed fetch path in the browser adapter.

The adapter also rewrites `/go-api/...` to `/api/...` before signing:

```text
/go-api/public/app-settings -> /api/public/app-settings
```

## Security session and signed fetch

The site uses a browser-loaded WASM module. The JavaScript wrapper expects these exports:

- `init(): Uint8Array`
- `finalizeHandshake(cid, server_pub, 1)`
- `signRequest(method, path, ts, nonce, body, userId): string`
- `verifyResponse(path, status, responseTimestamp, body, responseSignature): boolean`

Handshake request:

```http
POST /api/public/security/session/handshake
Content-Type: application/json

{
  "client_pub": "<base64 32-byte public key from wasm init()>",
  "ua_fingerprint": "sha256(userAgent|languages)",
  "ts": 1780746743571
}
```

Handshake response data shape:

```json
{
  "cid": "...",
  "server_pub": "<base64 32-byte public key>",
  "expires_at": 1780750000
}
```

Signed request headers:

```http
X-HDH-Cid: <cid>
X-HDH-TS: <Date.now() + clockSkewMs>
X-HDH-Nonce: <16 random bytes as hex>
X-HDH-Sig: <wasm signRequest output>
X-HDH-Kid: 1
```

The browser stores secure session data at:

- IndexedDB database: `hdh-secure-client`
- Object store: `secureClient`
- Key: `session`
- Fallback sessionStorage key: `hdh:secure-client:session`

## Response signature requirement

The bundle requires `X-HDH-RSig` on these exact paths:

- `/api/customer/user/checkin`
- `/api/customer/user/change-email/send-current-code`
- `/api/customer/user/change-email/verify-current-code`
- `/api/customer/user/change-email`
- `/api/customer/user/change-password`
- `/api/customer/vip/redeem`
- `/api/customer/user/current`
- `/api/customer/points-logs`

And these suffix patterns:

- `/api/customer/resources/:id/unlock`
- `/api/customer/music_resources/:id/unlock`
- `/api/customer/tv-follow/packs/:id/unlock`

## Public probes

Confirmed without login:

```http
GET /api/public/security/time
```

Sample shape:

```json
{
  "success": true,
  "data": { "server_time_ms": 1780746743571 },
  "message": "success",
  "code": "200"
}
```

Direct unauthenticated probes to signed paths return:

```json
{
  "code": "missing_signature",
  "message": "request signature missing",
  "success": false
}
```

The actual response text on the site is Chinese; the text above is normalized for this note.

## Login shape

The login page uses a Next.js Server Action, not a simple REST endpoint.

Observed action:

- Name: `login`
- Action id: `60a8e51aa9fa16f01cbaad3b32b28805276693cc21`
- Form defaults: `{ "username": "", "password": "" }`
- Submit payload adds:

```json
{
  "username": "<username or email>",
  "password": "<base64 utf8 password>",
  "password_transport": "base64"
}
```

This lab records that shape in `src/serverActions.ts`. It does not submit credentials.

## Search / TMDB proxy shape

The search UI calls a helper that:

1. Builds an object with `endpoint`, request params, and `utctimestamp` as Unix seconds.
2. Calls Server Action `encrypte` with id `40049854b309aa8ea669ee527cfcad9cf28dcb5c78`.
3. Sends `GET <endpoint>?query=<encrypted-string>`.
4. Calls Server Action `decrypt` with id `40de767e3029b7ee7ad7d9eb43ebd59a07971d91e8`.

Observed endpoints:

- `/go-api/proxy/tmdb/3/search/multi`
- `/go-api/proxy/tmdb/3/search/movie`
- `/go-api/proxy/tmdb/3/search/tv`
- `/go-api/proxy/tmdb/3/movie/:tmdbId`
- `/go-api/proxy/tmdb/3/tv/:tmdbId`

Because `/go-api` is normalized to `/api` before signed fetch, these calls also need the signed browser channel in production.

## Movie resource workflow

Movie pages render the resource list from Next.js Flight/RSC data. On the observed movie page the media record used:

```json
{
  "target_type": "media_resource",
  "target_id": 484,
  "target_key": "movie:484"
}
```

The rendered resource groups were keyed by net disk website id:

```json
["115", "123", "189", "quark", "aliPan"]
```

Relevant customer API routes found in the client bundles:

- `GET/POST /api/customer/resources`
- `/api/customer/check/resource`
- `/api/customer/resources/:id`
- `/api/customer/resources/:id/unlock`
- `/api/customer/resources/notify`

These routes are signed customer paths. Direct Node requests without the browser WASM signed channel return the `missing_signature` envelope described above.

### Resource page unlock action

Opening a resource page uses a route like:

```text
/resource/:website/:slug
```

For a Tianyi Cloud resource this is:

```text
/resource/189/:slug
```

The resource page can unlock by Next.js Server Action instead of directly exposing a JSON REST call to the browser. Observed request shape:

```http
POST /resource/189/:slug
Accept: text/x-component
Content-Type: text/plain;charset=UTF-8
Next-Action: 601a2054beb3034dd490287f5aa0d7c801f9e650c7
Next-Router-State-Tree: <current app-router state>

["<resourceSlug>","$T"]
```

Notes:

- The `Next-Action` id is build/deploy specific and should be rediscovered from the current bundle or browser request before relying on it.
- The request requires the logged-in browser session cookies. Do not persist real cookies in this lab.
- The response is a React Server Component stream (`text/x-component`). After a successful unlock, the page DOM renders the cloud share URL and any access code fields if present.
- Free resources may show `需要使用 0 积分解锁`; unlocking those increments the unlocked count but does not consume points.
