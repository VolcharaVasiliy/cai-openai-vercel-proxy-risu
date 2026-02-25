# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed broken `cai-default` model resolution by adding an internal placeholder mapping.
- Set new default placeholder character to `-EPBbF-2JeZep6sjrXfQ0aB_UdIZl4tSBwOwnNUB_F4`.
- Fixed chat routing docs/UI hints and continued history logic to avoid context overwrite.

## Files
- `lib/config.js` - added fallback mapping for `cai-default` to the new placeholder character when env mapping is absent.
- `api/v1/chat/completions.js` - stabilized turn handling:
  - keeps `system` from client only,
  - ensures latest user turn is present before upstream send,
  - resets upstream only for rewritten histories (not on repeated system block).
- `api/v1/health.js` - removed stale persona dependency and aligned provider hint with OpenAI-compatible usage.
- `index.html` - fixed setup guide for Risu (`OpenAI Compatible` + full chat endpoint URL), fixed broken Cyrillic sample text.
- `.env.example` - documented built-in placeholder and optional overrides.
- `README.md` - updated default placeholder behavior and request-flow description.

## Rationale
- Preview deployments had no Vercel env vars, causing `Unknown model "cai-default"` and a hard failure.
- Risu sends system blocks frequently; resetting upstream on every system delta caused context collapse.
- Placeholder had to be switched to the new requested character id globally.

## Issues
- Vercel project currently has no configured env vars; without code fallback this breaks model resolution.
- Fixed by code-level default mapping and by preparing env update/deploy flow.

## Functions
- `ensureTrailingUserTurn` (`api/v1/chat/completions.js`) - guarantees current user message is included in upstream transcript.
- `shouldResetConversation` (`api/v1/chat/completions.js`) - triggers reset only on non-append rewrites.
- `resolveCharacterId` / model map bootstrap (`lib/config.js`) - now always resolves `cai-default` via env mapping or placeholder fallback.

## Next steps
- Redeploy preview and verify `/v1/models` returns `cai-default`.
- Verify in Risu with multi-turn and regenerate/delete scenarios.
