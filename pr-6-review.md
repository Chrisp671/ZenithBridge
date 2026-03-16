## PR Review

### Do not merge as-is.

This PR bundles several unrelated features into a single change, some of which overlap with existing code and others that carry risk without adequate test coverage. Recommendation: split, drop the redundant parts, and re-submit the valuable pieces as focused PRs.

---

### Redundant — drop these

**Multiple terminal sessions**: Multi-session support already exists in `terminal-manager.ts` with session state persistence, ordinal numbering, and profile support. The max-sessions setting already exists in `settings.ts` (slider 1–12, default 4, with clamping). These changes duplicate what is already shipping and risk regressions against the existing implementation.

**`program.md`**: Planning/roadmap documents should not be checked into the shipping repo.

### Needs rethinking — drop or make opt-in

**`.claudeignore` auto-management**: Silently writing or modifying files in the user's vault is too opinionated. If this feature is desired, it should be opt-in via a setting, not automatic. As-is, it can surprise users and cause git conflicts.

### Valuable but needs its own focused PR with tests

**Streamable HTTP transport (MCP 2025-03-26)**: This is the highest-value and highest-risk part of the PR. The current codebase only supports SSE with the 2024-11-05 spec. Adding a new transport layer is a meaningful improvement, but it **must not merge without targeted transport-level tests** — connection lifecycle, session negotiation, error paths, and backward compatibility with SSE clients all need validation.

**Protocol version negotiation**: Currently hardcoded to `2024-11-05` in `handlers.ts`. Negotiation logic is a small, useful change that pairs naturally with the Streamable HTTP work.

### Worth cherry-picking

**HTTP session TTL** (1-hour expiry, 5-minute cleanup): Good server hygiene, low risk.

**JSON-RPC 2.0 error handling improvements**: Proper parse error codes and notification handling are straightforward correctness fixes.

---

### Summary

| Part | Recommendation |
|---|---|
| Multi-terminal sessions | **Drop** — already exists |
| Max sessions setting | **Drop** — already exists |
| `program.md` | **Drop** |
| `.claudeignore` auto-management | **Drop or make opt-in** |
| Streamable HTTP transport | **Keep** — resubmit as focused PR with transport tests |
| Protocol version negotiation | **Keep** — pair with Streamable HTTP PR |
| Session TTL / cleanup | **Cherry-pick** |
| JSON-RPC 2.0 error handling | **Cherry-pick** |
| Voice-to-text input | **Separate PR** if desired — niche feature |

The PR is too broad to review with confidence. Please split it so the genuinely new protocol work can get the focused validation it deserves.
