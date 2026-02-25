# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed broken `cai-default` model resolution by adding an internal placeholder mapping.
- Set new default placeholder character to `-EPBbF-2JeZep6sjrXfQ0aB_UdIZl4tSBwOwnNUB_F4`.
- Fixed chat routing docs/UI hints and continued history logic to avoid context overwrite.
- Added Risu blob parser to split bundled history into separate `assistant/user` turns.
- Simplified upstream mode to strict behavior: first message sends full context, all next messages send only user text.

## Files
- `lib/config.js` - added fallback mapping for `cai-default` to the new placeholder character when env mapping is absent.
- `api/v1/chat/completions.js` - stabilized turn handling:
  - keeps `system` from client only,
  - ensures latest user turn is present before upstream send,
  - parses Risu blobs (`Conversation history` + `Current user message`) even when mixed with other incoming messages,
  - forces extraction of the real current user text instead of storing whole serialized history as a user turn,
  - sends full transcript only on first message in session, then user-only on all continuation turns.
- `api/v1/health.js` - removed stale persona dependency and aligned provider hint with OpenAI-compatible usage.
- `index.html` - fixed setup guide for Risu (`OpenAI Compatible` + full chat endpoint URL), fixed broken Cyrillic sample text.
- `.env.example` - documented built-in placeholder and optional overrides.
- `README.md` - updated default placeholder behavior and request-flow description.

## Rationale
- Preview deployments had no Vercel env vars, causing `Unknown model "cai-default"` and a hard failure.
- User requested deterministic behavior without dynamic rewrite/system resync branches.
- Placeholder had to be switched to the new requested character id globally.
- Risu can send full chat history inside one `user` message; without parsing, proxy stored that entire block as one turn and produced role/message merging.

## Issues
- Vercel project currently has no configured env vars; without code fallback this breaks model resolution.
- Fixed by code-level default mapping and by preparing env update/deploy flow.

## Functions
- `ensureTrailingUserTurn` (`api/v1/chat/completions.js`) - guarantees current user message is included in upstream transcript.
- `parseRisuConversationBlob` (`api/v1/chat/completions.js`) - extracts system text, history turns, and current user message from bundled Risu payload.
- `rebuildMessagesFromRisuBlob` (`api/v1/chat/completions.js`) - normalizes parsed blob into standard OpenAI-style `system/user/assistant` list and prevents role/history collapsing into one user message.
- `resolveCharacterId` / model map bootstrap (`lib/config.js`) - now always resolves `cai-default` via env mapping or placeholder fallback.

## Next steps
- Redeploy production and verify first-turn full context + second-turn user-only flow in Risu.
