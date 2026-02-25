# Report - cai-openai-vercel-proxy-prod-clean - 2026-02-25

## Summary
- Deployed current stable version to Vercel production with shared alias URL.
- Published project to GitHub with clean structure and updated documentation.
- Kept per-user token mode as default (`Authorization` from client), with optional server fallback disabled unless explicitly enabled.
- Updated GitHub instructions for practical onboarding: one-click Vercel deploy, token extraction steps, and Risu setup without `reverse_proxy`.

## Files
- `README.md` - added Vercel one-click deploy button, public project URL, explicit token extraction via DevTools (`user/` -> `authorization`), and updated Risu setup (OpenAI-compatible mode, no `reverse_proxy`).
- `lib/config.js` - token resolution kept in secure default mode (`CAI_ALLOW_SERVER_TOKEN=true` required for server token fallback).
- `REPORT.md` - updated with final deploy/publication results.

## Rationale
- User requested production "normal" URL on Vercel and GitHub publication with clear explanation of how the code works.
- Documentation was restructured so a new user can deploy and configure the proxy end-to-end without prior context.
- User requested explicit token retrieval instructions and simpler Risu settings flow.

## Verification
- Production deploy completed and aliased:
  - `https://cai-openai-vercel-proxy-prod-clean.vercel.app`
- GitHub push completed:
  - `https://github.com/VolcharaVasiliy/cai-openai-vercel-proxy-risu`
- Prior behavior checks still valid:
  - No `Authorization` -> `401 missing_api_key`
  - With `Authorization` -> normal request processing

## Functions
- `resolveToken` (`lib/config.js`) - client token first, optional server fallback behind explicit flag.

## Next steps
- Optional: add release tags and semantic versioning (`v1.0.0`) for stable external sharing.
