# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Added upstream context optimization mode: full context once per session, then compact continuation prompts.
- Kept per-user token mode unchanged (`Authorization` required by default).
- Deployed preview build for validation.

## Files
- `api/v1/chat/completions.js` - added per-session prompt strategy state (`full` vs `compact`), context fingerprinting, compact prompt builder, optional force-full header.
- `.env.example` - added new context-mode env options (`CAI_CONTEXT_SEND_MODE`, compact tuning, periodic full refresh).
- `README.md` - documented hybrid context flow and new env variables.
- `REPORT.md` - updated with this optimization pass and verification.

## Rationale
- Risu often sends full system/history each request, creating unnecessary payload and latency.
- Sending full context once per session preserves role/world initialization while reducing repeated overhead on subsequent turns.
- Automatic full resend triggers when persona/system context changes, preventing stale prompt behavior.

## Verification
- Syntax checks passed:
  - `node --check api/v1/chat/completions.js`
  - `node --check lib/memory.js`
  - `node --check lib/config.js`
- Preview deploy:
  - `https://cai-openai-vercel-proxy-prod-clean-kcc2sre0l.vercel.app`
- Runtime checks on preview:
  - No `Authorization` -> `401`
  - Local memory intents still work (`remember 42` -> `42`).

## Functions
- `shouldUseFullContextPrompt` (`api/v1/chat/completions.js`) - chooses full vs compact upstream prompt per session.
- `buildCompactPrompt` (`api/v1/chat/completions.js`) - compact continuation payload for subsequent turns.
- `markContextPromptSent` (`api/v1/chat/completions.js`) - tracks prompt strategy state in session cache.

## Next steps
- Validate latency/quality in Risu on the preview URL and, if acceptable, roll to production alias.
