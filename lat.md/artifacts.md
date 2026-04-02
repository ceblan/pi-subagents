# Artifacts

The extension writes per-run debug artifacts so runs can be inspected post-hoc without replaying the session.

## Artifact Files

For each agent run, four files are written under `{sessionDir}/subagent-artifacts/` (or `<tmpdir>/pi-subagent-artifacts/` if no session dir):

| File | Description |
|------|-------------|
| `{runId}_{agent}_input.md` | Task prompt sent to the agent |
| `{runId}_{agent}_output.md` | Full untruncated output |
| `{runId}_{agent}.jsonl` | Raw event stream (sync mode only) |
| `{runId}_{agent}_meta.json` | Timing, exit code, token usage |

File writing is managed by [[artifacts.ts#writeArtifact]] and [[artifacts.ts#writeMetadata]].

## Configuration

Artifact generation is controlled by `ArtifactConfig` in [[types.ts]].

The default config enables all artifact types except JSONL (to keep disk usage reasonable) with a 7-day cleanup age. Artifacts can be disabled entirely via the `artifacts: false` tool parameter.

## Cleanup

`cleanupOldArtifacts` in [[artifacts.ts]] removes artifact directories older than `cleanupDays` days. It runs per-session on `session_start`. `cleanupAllArtifactDirs` runs a broader sweep across all known artifact locations at extension startup.

## Artifact Path Embedding

When output is truncated, `truncateOutput` in [[types.ts]] embeds the artifact output file path in the truncation notice so the caller can find the full text.
