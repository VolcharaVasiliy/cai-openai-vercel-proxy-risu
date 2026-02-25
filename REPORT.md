# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Kept per-user token mode (client `Authorization` required by default).
- Rolled back latency-focused context reductions to prior defaults to preserve memory/quality behavior.
- Reverted aggressive speed tweaks in prompt/history shaping and conversation bootstrap wait.

## Files
- `lib/config.js` - kept token policy: server token fallback requires `CAI_ALLOW_SERVER_TOKEN=true`.
- `lib/memory.js` - reverted to previous memory defaults and history rendering behavior.
- `lib/cai.js` - reverted conversation bootstrap soft timeout to previous value.
- `api/v1/chat/completions.js` - reverted prompt clipping defaults for system and sample text.
- `.env.example` - removed speed-tuning env vars and restored previous memory default values.
- `README.md` - removed speed-tuning env bullets.

## Rationale
- User asked to avoid possible quality/memory regressions from speed tuning.
- Per-user token requirement remains intact and independent from context-size tuning.

## Verification
- Syntax checks passed:
  - `node --check api/v1/chat/completions.js`
  - `node --check lib/config.js`
  - `node --check lib/memory.js`
  - `node --check lib/cai.js`
- Behavioral checks expected after deploy:
  - No `Authorization` -> `401 missing_api_key`
  - With `Authorization` -> normal processing

## Next steps
- Deploy updated preview and verify in Risu with your normal card/prompt.
