# c.ai -> OpenAI-Compatible Proxy (Vercel)

Production-ready serverless proxy that lets OpenAI-compatible clients (Risu, custom apps) call Character.AI through standard endpoints.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/VolcharaVasiliy/cai-openai-vercel-proxy-risu&project-name=cai-openai-vercel-proxy-risu&repository-name=cai-openai-vercel-proxy-risu&env=CAI_CHARACTER_ID,CAI_MODEL_ALIAS,CAI_ALLOW_SERVER_TOKEN&envDescription=Set%20character%20id%20and%20model%20alias.%20Keep%20server%20token%20disabled.&envLink=https://github.com/VolcharaVasiliy/cai-openai-vercel-proxy-risu#environment-variables)

## Public project URL

- Current public URL: `https://cai-openai-vercel-proxy-prod-clean.vercel.app`
- You can deploy your own copy with the button above and get your own URL.

## How to get c.ai token

1. Open your target character page on Character.AI.
2. Press `F12` to open DevTools.
3. Refresh the page (`Ctrl+R`).
4. Open Network tab and find a request that contains `user/` in URL.
5. Open request headers and copy `authorization` value.
6. Use this value as your token in Risu/API key field.

Do not share this token with other people.

## What this project solves

- OpenAI-compatible API surface for c.ai.
- Model alias layer (`model` -> hidden `character_id`) so client apps do not expose character IDs.
- Session memory at proxy level.
- Basic leakage guard for hidden platform/profile identifiers.
- Risu-friendly integration (OpenAI-compatible mode).

## API endpoints

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /v1/health`
- `GET /` (guide/check page)

Compatibility aliases:

- `POST /chat/completions`
- `GET /models`
- `GET /health`

## How request flow works

1. Client sends OpenAI-style request to `/v1/chat/completions`.
2. Proxy validates `model`, messages, and user token (`Authorization: Bearer <cai_token>`).
3. Proxy resolves character by alias (`CAI_MODEL_ALIAS` / `CAI_MODEL_MAP_JSON`).
4. Proxy merges/synchronizes session history (`X-Session-Id` or `user`).
5. Proxy builds a guarded upstream prompt (with system + style hints + history).
6. By default, proxy sends full context once per session and then compact continuation prompts.
7. Proxy sends message to c.ai via `cainode`.
8. Proxy sanitizes output and returns OpenAI-compatible response JSON.

## Core files and responsibilities

- `api/v1/chat/completions.js`
  Request validation, persona/session logic, local memory intents, sanitization, OpenAI response formatting.
- `api/v1/models.js`
  Exposes available model aliases for clients.
- `api/v1/health.js`
  Health/status endpoint for checks.
- `lib/config.js`
  Env config parsing, model map resolution, token/session helpers.
- `lib/cai.js`
  c.ai client connect/send logic with retries and timeouts.
- `lib/memory.js`
  In-process chat session memory and history block creation.
- `lib/openai-format.js`
  OpenAI-compatible completion and SSE chunk builders.

## Token model (important)

Default mode: token must come from client request.

- Required: `Authorization: Bearer <cai_token>`
- Optional fallback (disabled by default): set both
  - `CAI_ALLOW_SERVER_TOKEN=true`
  - `CAI_TOKEN=<token>`

This is safer for shared deployments where each user should use their own token.

## Session memory

- Session key uses token fingerprint + model + session id.
- Recommended header: `X-Session-Id: <session_id>`.
- Fallback session source: OpenAI `user` field.
- If client sends full message history, proxy uses it.
- If client sends only last user message, proxy extends history from in-memory store.

## Risu setup (recommended)

Settings:

- Provider/Model type: OpenAI-compatible (do not use `reverse_proxy`)
- URL: `https://your-project.vercel.app/v1/chat/completions`
- Key/Password: user c.ai token
- Model: alias from `/v1/models` (example `cai-default`)
- Streaming: recommended OFF for first test

## Environment variables

Minimum:

- `CAI_CHARACTER_ID=<character_id>`
- `CAI_MODEL_ALIAS=cai-default`

Optional multi-alias:

- `CAI_MODEL_MAP_JSON={"cai-default":"CHAR_ID_1","cai-creative":"CHAR_ID_2"}`

Optional:

- `CAI_ALLOW_SERVER_TOKEN=true`
- `CAI_TOKEN=<token>`
- `CAI_LEAK_GUARD_TERMS=term1,term2`
- `CAI_MEMORY_MAX_TURNS=24`
- `CAI_MEMORY_MAX_CHARS=1200`
- `CAI_REQUEST_TIMEOUT_MS=60000`
- `CAI_CONNECT_TIMEOUT_MS=45000`
- `CAI_CONTEXT_SEND_MODE=hybrid` (`hybrid` or `full`)
- `CAI_COMPACT_HISTORY_TURNS=4`
- `CAI_COMPACT_HISTORY_CHARS=280`
- `CAI_FULL_CONTEXT_EVERY_TURNS=0`

See `.env.example`.

## Local development

```bash
npm install
npm run dev
```

If `vercel dev` asks for login:

```bash
npm run dev:local
```

## Example request

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CAI_TOKEN" \
  -H "X-Session-Id: demo-1" \
  -d '{
    "model": "cai-default",
    "messages": [
      {"role":"user","content":"Hello"}
    ],
    "stream": false
  }'
```

## Deploy

Preview:

```bash
vercel deploy -y
```

Production:

```bash
vercel deploy --prod -y
```

## Notes and limitations

- c.ai backend is character-centric; this proxy maps alias to character id.
- Memory and persona cache are in-process (serverless instance-local).
- Cold starts and c.ai upstream latency are expected in serverless mode.
- In `hybrid` context mode, the first turn per session is full context and following turns are compact for lower latency.
