# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Fixed broken `cai-default` model resolution by adding an internal placeholder mapping.
- Set new default placeholder character to `-EPBbF-2JeZep6sjrXfQ0aB_UdIZl4tSBwOwnNUB_F4`.
- Fixed chat routing docs/UI hints and continued history logic to avoid context overwrite.
- Upgraded Risu blob parser to support both `history + current message` and `history-only` payloads.
- Expanded parser robustness for multilingual markers/roles and marker-free role blocks.
- Stabilized continuation flow: first message uses full transcript, later messages use user-only without wiping stored history.
- Removed unstable implicit alias mechanism and returned to explicit/default session routing.
- Removed turn-count memory cap (`CAI_MEMORY_MAX_TURNS`) to keep full in-memory history.
- Hardened regenerate/delete handling so tail rewrites reset upstream conversation and keep roles split correctly.
- Disabled content clamps by default (`CAI_MEMORY_MAX_CHARS=0`, `CAI_MAX_ASSISTANT_CHARS=0`) so history/answers are not truncated.
- Stabilized session keying for Risu by defaulting away from `body.user` (unless explicitly enabled).
- Enabled authoritative incoming-history mode by default for stable memory in serverless (`CAI_AUTHORITATIVE_HISTORY=true`).
- Fixed root cause of memory loss on cold starts: removed unconditional `create_new_conversation()` on client bootstrap.
- Fixed message-collapse issue where full history could be stored as one `user` turn when speaker labels were non-standard.
- Fixed stale-blob selection: parser now only rebuilds from the latest user blob, never from older user turns.
- Improved fallback extraction for history-only payloads with speaker names (`XLEB`, character names), returning only the latest user utterance instead of whole serialized history.
- Added tolerant request decoding for proxy-wrapped payloads (nested JSON strings and loose JSON object fragments).
- Added tolerant `messages` coercion from serialized role/content strings (including escaped `\\\"role\\\"` form).
- Forced single-choice output by default (ignores `n > 1` unless explicitly enabled) to prevent duplicated/looped assistant outputs in Risu.
- Added an experimental replay sync mode to avoid c.ai-side "single glued message" behavior during full synchronization.
- Fixed replay-mode over-sync: old assistant turns no longer regenerate on every new user message by default.
- Added replay cold-start continuation heuristic to avoid unnecessary full replay when incoming history already contains assistant turns.
- Replay mode now applies rewrite/full-resync using explicit signals plus guarded heuristics to preserve regenerate/delete support.
- Fixed implicit session routing so new chats do not stick to old sessions when no explicit session id is provided.
- Re-enabled heuristic rewrite detection (with continuation guard) so regenerate/delete can work without explicit flags.
- Replaced sticky default-session fallback with context-stable session ids plus forced fresh reset on short-history starts.

## Files
- `lib/config.js` - added fallback mapping for `cai-default` to the new placeholder character when env mapping is absent.
- `api/v1/chat/completions.js` - stabilized turn handling:
  - keeps `system` from client only,
  - ensures latest user turn is present before upstream send,
  - parses Risu blobs from the last parseable `user` message instead of trusting only the final one,
  - supports `history-only` and `history + current user` formats,
  - supports localized markers/roles and marker-free role transcripts when both `user/assistant` roles are present,
  - infers roles for non-standard speaker labels (for example character names) to keep turns separate,
  - falls back to extracting only current user text when serialized blobs slip through parsing,
  - rebuilds from last user message only (prevents stale history replay),
  - accepts proxied/loose body encodings and normalizes them before routing,
  - can recover `messages` when provided as serialized `role/content` string instead of array,
  - forces extraction of real user turns instead of storing the whole serialized history as one `user` entry,
  - sends full transcript only on first turn and user-only on continuation turns,
  - applies non-append incoming history for near-tail rewrites (regenerate/delete/edit),
  - ignores other non-append overwrites to prevent accidental context reset on turn 3+.
- `lib/memory.js` - removed hard turn slicing; session history is no longer trimmed by count.
- `lib/memory.js` - default per-message clamp is now unlimited; clamp applies only when env limit is set.
- `api/v1/chat/completions.js` - default assistant output clamp is now unlimited; optional clamp via env.
- `api/v1/chat/completions.js` - session id now prefers conversation/chat ids; `body.user` is opt-in (`CAI_SESSION_USE_BODY_USER=true`).
- `api/v1/chat/completions.js` - if client sends history, proxy syncs full transcript with upstream reset by default (authoritative mode).
- `api/v1/chat/completions.js` - response now defaults to single `choices[0]`; multi-choice is opt-in via `CAI_ALLOW_MULTI_CHOICE=true`.
- `api/v1/chat/completions.js` - added sync mode selector (`prompt`/`replay`) with optional request overrides (`x-cai-sync-mode`, `proxy_sync_mode`).
- `api/v1/chat/completions.js` - in replay full-sync, forces conversation reset and rebuilds history via separate upstream user turns.
- `api/v1/chat/completions.js` - optional debug headers (`X-Proxy-Sync-Mode`, replay stats) behind `CAI_DEBUG_SYNC_HEADERS`.
- `api/v1/chat/completions.js` - replay mode now disables authoritative full-sync by default (opt-in via `CAI_REPLAY_AUTHORITATIVE_HISTORY=true`).
- `api/v1/chat/completions.js` - replay mode now assumes continuation on cold starts when incoming history includes assistant turns (opt-out via `CAI_REPLAY_ASSUME_CONTINUATION=false`).
- `api/v1/chat/completions.js` - in replay mode with non-authoritative sync, rewrite path uses explicit flags + continuation-safe heuristics.
- `api/v1/chat/completions.js` - default-session now derives from incoming context (`system` + early turns), not only from system hash or global alias.
- `api/v1/chat/completions.js` - rewrite detection now combines explicit rewrite signal + guarded heuristic to avoid false rewrites on normal user continuations.
- `api/v1/chat/completions.js` - debug headers now include resolved session source/id for easier diagnosis.
- `api/v1/chat/completions.js` - short-history requests now force upstream conversation reset unless explicit session id is provided.
- `api/v1/chat/completions.js` - context alias map now drives no-id continuation; token/model alias fallback is opt-in only.
- `lib/cai.js` - no longer creates a fresh c.ai conversation on every new client; reset now happens only on explicit rewrite/reset path.
- `lib/cai.js` - added `sendCharacterMessageWithReplaySync` for turn-by-turn history replay instead of one transcript blob.
- `lib/config.js` - keeps explicit session resolution from headers/body (`X-Session-Id`/`user`).
- `api/v1/health.js` - removed stale persona dependency and aligned provider hint with OpenAI-compatible usage.
- `index.html` - fixed setup guide for Risu (`OpenAI Compatible` + full chat endpoint URL), fixed broken Cyrillic sample text.
- `.env.example` - documented replay sync toggles (`CAI_SYNC_MODE`, replay knobs, optional debug headers).
- `README.md` - documented replay sync toggles and behavior.

## Rationale
- Preview deployments had no Vercel env vars, causing `Unknown model "cai-default"` and a hard failure.
- Missing/unstable session ids caused conversations to collide or lose context across chats.
- Placeholder had to be switched to the new requested character id globally.
- Risu can send full chat history inside one `user` message; without parsing, proxy stored that entire block as one turn and produced role/message merging.
- Risu regenerate/delete flows can send history snapshots without `Current user message`; parser now accepts that shape.
- Some Risu payloads use localized role/marker labels; parser now normalizes role tokens and markers.
- Some payloads use speaker names instead of `Assistant/User`; parser now infers role mapping to prevent turn merging.
- Some reverse-proxy channels can wrap/double-stringify JSON or flatten `messages`; parser now tolerates these encodings.
- Some clients send shortened history on later turns; accepting it as source-of-truth caused accidental wipe after the second message.
- Regenerate/delete require controlled non-append updates; without rewrite detection they were treated as plain resend.
- User explicitly requested unlimited in-memory turns; count cap was removed while preserving per-message clamp.
- User explicitly requested no limits; default char clamps were switched to unlimited.
- Unstable OpenAI `user` field can rotate between requests; by default it no longer drives session id.
- Serverless instances can rotate; authoritative mode rebuilds conversation from client history each turn to avoid losing context.
- New client bootstrap previously forced a fresh chat and wiped continuity; this reset is now explicit-only.
- Some clients send `n > 1`; duplicated assistant choices can break Risu parsing, so single-choice is now the safe default.
- Full transcript sync can appear as one glued message in native c.ai history; replay mode addresses this by reconstructing with discrete user turns.
- For replay mode, authoritative full-sync each turn causes visible re-generation of old assistant replies; default behavior now avoids that.
- Serverless cold starts can make runtime state appear uninitialized; replay continuation heuristic prevents needless re-bootstrap/replay loops.
- Non-append detection can trigger on benign formatting drift; replay mode now uses continuation guard to avoid false rewrite/full-resync.
- System-only implicit session ids caused chat stickiness across new chats; implicit derivation now includes user/assistant context.
- Explicit-only rewrite gating broke regenerate when clients do not send rewrite flags; guarded heuristic restores regen support.
- Default token/model alias fallback can merge unrelated chats; it is now disabled by default behind env switch.

## Issues
- Vercel project currently has no configured env vars; without code fallback this breaks model resolution.
- Fixed by code-level default mapping and by preparing env update/deploy flow.

## Functions
- `ensureTrailingUserTurn` (`api/v1/chat/completions.js`) - guarantees current user message is included in upstream transcript.
- `shouldApplyRewrite` (`api/v1/chat/completions.js`) - validates whether non-append history should be treated as regenerate/delete/edit.
- `hasExplicitRewriteSignal` (`api/v1/chat/completions.js`) - detects explicit rewrite/regenerate/delete flags in request body.
- `parseHistoryTurns` (`api/v1/chat/completions.js`) - parses multi-line `assistant/user` history blocks into normalized turns.
- `inferRoleFromLabel` (`api/v1/chat/completions.js`) - infers roles for unknown speaker labels based on context.
- `normalizeRoleToken` (`api/v1/chat/completions.js`) - maps localized role names to canonical `user/assistant`.
- `matchesMarkerLabel` (`api/v1/chat/completions.js`) - marker matching tolerant to language/format variants.
- `parseRisuConversationBlob` (`api/v1/chat/completions.js`) - extracts system text, history turns, and current user message from bundled Risu payload.
- `rebuildMessagesFromRisuBlob` (`api/v1/chat/completions.js`) - normalizes parsed blob into standard OpenAI-style `system/user/assistant` list and prevents role/history collapsing into one user message.
- `sanitizeSerializedUserMessage` (`api/v1/chat/completions.js`) - defensive fallback to avoid storing full serialized history as a single user turn.
- `parsePossiblyNestedJson` (`api/v1/chat/completions.js`) - unwraps nested JSON string payloads safely.
- `tryParseLooseJsonObject` (`api/v1/chat/completions.js`) - parses loose key/value body fragments into object form.
- `coerceMessagesToArray` (`api/v1/chat/completions.js`) - coerces `messages` from array/object/string representations.
- `extractRoleContentPairsFromSerializedText` (`api/v1/chat/completions.js`) - extracts `role/content` pairs from serialized proxy strings.
- `resolveSyncMode` (`api/v1/chat/completions.js`) - resolves sync strategy from request/env.
- `allowReplayAuthoritativeMode` (`api/v1/chat/completions.js`) - controls whether replay mode may force authoritative full-sync every turn.
- `assumeReplayContinuationFromIncomingHistory` (`api/v1/chat/completions.js`) - controls cold-start continuation heuristic in replay mode.
- `deriveImplicitSessionId` (`api/v1/chat/completions.js`) - creates stable context-based session ids when explicit ids are absent.
- `looksLikeContinuationTurn` (`api/v1/chat/completions.js`) - guards heuristic rewrite detection from firing on normal next-user turns.
- `hasExplicitSessionRequest` (`api/v1/chat/completions.js`) - detects explicit session ids from headers/body.
- `allowSessionAliasFallback` (`api/v1/chat/completions.js`) - controls legacy token/model fallback behavior.
- `resolveSessionId` (`lib/config.js`) - resolves explicit session from headers/user field.
- `resolveCharacterId` / model map bootstrap (`lib/config.js`) - resolves `cai-default` via env mapping or placeholder fallback.
- `sendCharacterMessageWithReplaySync` (`lib/cai.js`) - rebuilds full-sync context by replaying user turns to c.ai.

## Next steps
- Redeploy production and verify turn 1, 2, 3+ remain in one continuous history.
