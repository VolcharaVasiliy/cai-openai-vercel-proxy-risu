# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed role/history regression where continuation could collapse and behave like single-turn overwrite.
- Removed proxy-authored policy prompts from upstream path; only client transcript content is forwarded.
- Added sync strategy: full transcript sync on first turn/rewrite, then latest-user-only continuation.

## Files
- `api/v1/chat/completions.js` - reworked session flow:
  - separates `system` and `user/assistant` turns,
  - keeps runtime session state,
  - performs full transcript sync only when needed,
  - preserves separate user/assistant turns,
  - resets upstream conversation on rewritten history.
- `lib/cai.js` - keeps `resetConversation` support to recreate conversation branch when history is edited/regenerated.
- `lib/memory.js` - increased default per-message memory cap to reduce truncation of long roleplay entries.
- `.env.example` - updated `CAI_MEMORY_MAX_CHARS` default guidance.
- `README.md` - updated request-flow explanation and memory default.

## Rationale
- User reported critical behavior: assistant/user role flow broke and character definition/greeting context was not reliably preserved.
- Root causes were mixed history-source assumptions and aggressive truncation for long narrative/system content.
- New logic prioritizes stable continuation while still supporting regenerate/delete rewrite scenarios.

## Verification
- Syntax checks passed:
  - `node --check api/v1/chat/completions.js`
  - `node --check lib/cai.js`
  - `node --check lib/memory.js`
  - `node --check lib/config.js`
- Auth behavior check retained:
  - no `Authorization` -> `401 missing_api_key`

## Functions
- `splitIncomingMessages` (`api/v1/chat/completions.js`) - separates system context from dialogue turns.
- `shouldResetConversation` (`api/v1/chat/completions.js`) - detects non-append rewrite cases.
- `buildTranscriptPrompt` (`api/v1/chat/completions.js`) - full-sync transcript serialization with explicit role blocks.
- `sendCharacterMessage(..., resetConversation)` (`lib/cai.js`) - reset-capable upstream send.

## Next steps
- Validate on preview in Risu with long system + greeting + multi-turn continuation.
- If stable, roll this build to production alias.
