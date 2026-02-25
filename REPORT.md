# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed broken `cai-default` model resolution by adding an internal placeholder mapping.
- Set new default placeholder character to `-EPBbF-2JeZep6sjrXfQ0aB_UdIZl4tSBwOwnNUB_F4`.
- Fixed chat routing docs/UI hints and continued history logic to avoid context overwrite.
- Added Risu blob parser to split bundled history into separate `assistant/user` turns.
- Stabilized continuation flow: first message uses full transcript, later messages use user-only without wiping stored history.
- Removed unstable implicit alias mechanism and returned to explicit/default session routing.
- Added safe regenerate/delete support via rewrite detection on near-tail history edits.
- Improved Risu blob parser to handle regenerate/delete payloads without `Current user message`.
- Raised default memory turn cap to `400` for long dialogues (300+ turns).

## Files
- `lib/config.js` - added fallback mapping for `cai-default` to the new placeholder character when env mapping is absent.
- `api/v1/chat/completions.js` - stabilized turn handling:
  - keeps `system` from client only,
  - ensures latest user turn is present before upstream send,
  - parses Risu blobs (`Conversation history` + `Current user message`) even when mixed with other incoming messages,
  - forces extraction of the real current user text instead of storing whole serialized history as a user turn,
  - sends full transcript only on first turn and user-only on continuation turns,
  - applies non-append incoming history only when it looks like regenerate/delete/edit (tail rewrite),
  - ignores other non-append overwrites to prevent accidental context reset on turn 3+,
  - parses history-only blobs (no current-user marker) so regenerate/delete no longer collapses into one message.
- `lib/memory.js` - default `CAI_MEMORY_MAX_TURNS` increased from `24` to `400`.
- `lib/config.js` - keeps explicit session resolution from headers/body (`X-Session-Id`/`user`).
- `api/v1/health.js` - removed stale persona dependency and aligned provider hint with OpenAI-compatible usage.
- `index.html` - fixed setup guide for Risu (`OpenAI Compatible` + full chat endpoint URL), fixed broken Cyrillic sample text.
- `.env.example` - documented built-in placeholder and optional overrides.
- `README.md` - updated default placeholder behavior and request-flow description.

## Rationale
- Preview deployments had no Vercel env vars, causing `Unknown model "cai-default"` and a hard failure.
- Missing/unstable session ids caused conversations to collide or lose context across chats.
- Placeholder had to be switched to the new requested character id globally.
- Risu can send full chat history inside one `user` message; without parsing, proxy stored that entire block as one turn and produced role/message merging.
- Some clients send shortened history on later turns; accepting it as source-of-truth caused accidental wipe after the second message.
- Regenerate/delete require controlled non-append updates; without rewrite detection they were treated as plain resend.
- Risu regenerate/delete can send history-only serialized blocks; parser now accepts this format.

## Issues
- Vercel project currently has no configured env vars; without code fallback this breaks model resolution.
- Fixed by code-level default mapping and by preparing env update/deploy flow.

## Functions
- `ensureTrailingUserTurn` (`api/v1/chat/completions.js`) - guarantees current user message is included in upstream transcript.
- `shouldApplyRewrite` (`api/v1/chat/completions.js`) - validates whether non-append history should be treated as regenerate/delete/edit.
- `hasExplicitRewriteSignal` (`api/v1/chat/completions.js`) - detects explicit rewrite/regenerate/delete flags in request body.
- `parseRisuConversationBlob` (`api/v1/chat/completions.js`) - now supports both `history + current user` and `history-only` blob formats.
- `rebuildMessagesFromRisuBlob` (`api/v1/chat/completions.js`) - normalizes parsed blob into standard OpenAI-style `system/user/assistant` list and prevents role/history collapsing into one user message.
- `resolveSessionId` (`lib/config.js`) - resolves explicit session from headers/user field.
- `resolveCharacterId` / model map bootstrap (`lib/config.js`) - resolves `cai-default` via env mapping or placeholder fallback.

## Next steps
- Redeploy production and verify turn 1, 2, 3+ remain in one continuous history.
