# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Removed proxy-authored roleplay policy prompts from upstream request construction.
- Switched upstream payload generation to direct transcript pass-through from incoming Risu/OpenAI messages (`system/user/assistant`).
- Added conversation reset on non-append history rewrites to improve delete/regenerate behavior.

## Files
- `api/v1/chat/completions.js` - rewritten chat pipeline to remove custom policy/persona prompt layers; now serializes incoming messages directly; detects history rewrite and requests upstream conversation reset.
- `lib/cai.js` - `sendCharacterMessage` extended with optional `resetConversation` flag; performs best-effort `create_new_conversation` before send.
- `.env.example` - removed hybrid-context tuning envs no longer used.
- `README.md` - updated flow docs: no proxy policy prompt, direct transcript forwarding, and rewrite-reset behavior.
- `REPORT.md` - updated with this fix pass.

## Rationale
- User requirement: only Risu prompt/content should be sent, without extra proxy-authored prompt policy.
- Reported bug: each turn behaved like single-message overwrite after previous optimization pass.
- Direct transcript forwarding with rewrite detection is more compatible with Risu full-history mode and message edits.

## Verification
- Syntax checks passed:
  - `node --check api/v1/chat/completions.js`
  - `node --check lib/cai.js`
  - `node --check lib/memory.js`
  - `node --check lib/config.js`
- Local behavior checks:
  - No `Authorization` -> `401 missing_api_key`

## Functions
- `buildUpstreamPrompt` (`api/v1/chat/completions.js`) - builds upstream text strictly from incoming normalized messages.
- `shouldResetConversation` (`api/v1/chat/completions.js`) - detects non-append history rewrite cases.
- `sendCharacterMessage(..., resetConversation)` (`lib/cai.js`) - optionally resets c.ai conversation before send.

## Next steps
- Validate in Risu on preview URL for normal turn continuation and regenerate/delete flows.
- If stable, roll to production alias and keep this as default behavior.
