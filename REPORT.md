# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed broken `cai-default` model resolution by adding an internal placeholder mapping.
- Set new default placeholder character to `-EPBbF-2JeZep6sjrXfQ0aB_UdIZl4tSBwOwnNUB_F4`.
- Fixed chat routing docs/UI hints and continued history logic to avoid context overwrite.
- Added Risu blob parser to split bundled history into separate `assistant/user` turns.
- Added stable dialog binding with implicit session aliases when client does not pass one.
- Added fail-safe full re-sync on rewritten history while keeping user-only continuation for normal turns.

## Files
- `lib/config.js` - added fallback mapping for `cai-default` to the new placeholder character when env mapping is absent.
- `api/v1/chat/completions.js` - stabilized turn handling:
  - keeps `system` from client only,
  - ensures latest user turn is present before upstream send,
  - detects non-append history rewrites and triggers upstream branch reset + full re-sync,
  - parses Risu blobs (`Conversation history` + `Current user message`) even when mixed with other incoming messages,
  - forces extraction of the real current user text instead of storing whole serialized history as a user turn,
  - sends full transcript on first turn/rewrite and user-only on normal continuation turns.
- `lib/config.js` - keeps explicit session resolution from headers/body (`X-Session-Id`/`user`).
- `api/v1/chat/completions.js` - adds implicit alias store that reuses the same internal session id via message/system hints when explicit id is missing.
- `api/v1/health.js` - removed stale persona dependency and aligned provider hint with OpenAI-compatible usage.
- `index.html` - fixed setup guide for Risu (`OpenAI Compatible` + full chat endpoint URL), fixed broken Cyrillic sample text.
- `.env.example` - documented built-in placeholder and optional overrides.
- `README.md` - updated default placeholder behavior and request-flow description.

## Rationale
- Preview deployments had no Vercel env vars, causing `Unknown model "cai-default"` and a hard failure.
- Missing/unstable session ids caused conversations to collide or lose context across chats.
- Placeholder had to be switched to the new requested character id globally.
- Risu can send full chat history inside one `user` message; without parsing, proxy stored that entire block as one turn and produced role/message merging.

## Issues
- Vercel project currently has no configured env vars; without code fallback this breaks model resolution.
- Fixed by code-level default mapping and by preparing env update/deploy flow.

## Functions
- `ensureTrailingUserTurn` (`api/v1/chat/completions.js`) - guarantees current user message is included in upstream transcript.
- `shouldResetConversation` (`api/v1/chat/completions.js`) - detects rewritten non-append history for full re-sync.
- `parseRisuConversationBlob` (`api/v1/chat/completions.js`) - extracts system text, history turns, and current user message from bundled Risu payload.
- `rebuildMessagesFromRisuBlob` (`api/v1/chat/completions.js`) - normalizes parsed blob into standard OpenAI-style `system/user/assistant` list and prevents role/history collapsing into one user message.
- `resolveSessionId` (`lib/config.js`) - resolves explicit session from headers/user field.
- `collectSessionHints` / `tryResolveImplicitSessionId` (`api/v1/chat/completions.js`) - maintain no-id dialog continuity across turns.
- `resolveCharacterId` / model map bootstrap (`lib/config.js`) - resolves `cai-default` via env mapping or placeholder fallback.

## Next steps
- Redeploy production and verify each Risu chat keeps its own isolated session without context loss.
