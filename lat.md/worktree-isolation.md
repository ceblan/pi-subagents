# Worktree Isolation

Worktree isolation gives each parallel agent its own dedicated git working tree, preventing file conflicts when multiple agents modify the same repository concurrently.

## Mechanism

`createWorktrees` in [[worktree.ts]] runs `git worktree add` per parallel task, creating a temporary branch and worktree at `<tmpdir>/pi-worktree-*`.

Each agent's `cwd` is redirected to its worktree root (preserving any subdirectory offset). `node_modules/` directories are symlinked into each worktree to avoid reinstalling packages.

## Diff Capture

After all parallel tasks complete, `diffWorktrees` captures `git add -A && git diff --cached` in each worktree.

The result is a `WorktreeDiff` with stats (`filesChanged`, `insertions`, `deletions`) and a `.patch` file written to the artifacts directory.

## Output Aggregation

`formatWorktreeDiffSummary` in [[worktree.ts]] formats per-agent diffs as a summary appended to the aggregated parallel output. This becomes `{previous}` for the next chain step. Full diff stats and patch file paths are included.

## Cleanup

Worktrees are removed in a `finally` block regardless of success or failure. `cleanupWorktrees` calls `git worktree remove --force` followed by `git branch -D` for each temporary branch.

## Requirements and Constraints

Must be inside a git repository with a clean working tree (no uncommitted changes — commit or stash first).

Task-level `cwd` overrides must not differ from the shared parallel step `cwd`. Conflict detection via `findWorktreeTaskCwdConflict` in [[worktree.ts]] validates this constraint before creating worktrees. If different directories are needed, disable `worktree` or split the run.
