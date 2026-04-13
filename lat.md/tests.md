# Tests

The project has three test suites: unit, integration, and e2e. Tests use Node.js built-in `node:test` with TypeScript via `--experimental-strip-types`. Test infrastructure lives in `test/support/`.

## Unit Tests

Fast, pure tests in `test/unit/` that import individual modules directly with no mocking. Run with `npm run test:unit` using the built-in strip-types loader.

Key unit test areas:

- **Recursion guard** (`recursion-guard.test.ts`): Verifies `checkSubagentDepth` and `getSubagentDepthEnv` enforce the two-level default and respond correctly to `PI_SUBAGENT_MAX_DEPTH` overrides.
- **Schemas** (`schemas.test.ts`): Validates TypeBox parameter schema shapes — `context` enum, `tasks[].count` minimum, `StatusParams.action` description.
- **Agent scope** (`agent-scope.test.ts`): Tests scope resolution logic and collision precedence between builtin/user/project agents.
- **Agent selection** (`agent-selection.test.ts`): Tests multi-select state merging across scopes.
- **Completion dedupe** (`completion-dedupe.test.ts`): Tests TTL-based deduplication for async completion keys.
- **File coalescer** (`file-coalescer.test.ts`): Tests debounced write scheduling and coalescing.
- **Fork context** (`fork-context.test.ts`): Tests `resolveSubagentContext` and `createForkContextResolver` fail-fast behaviors.
- **Pi args** (`pi-args.test.ts`): Tests CLI argument construction and thinking suffix application.
- **Pi spawn** (`pi-spawn.test.ts`): Tests cross-platform pi executable resolution.
- **Parallel utils** (`parallel-utils.test.ts`): Tests `mapConcurrent`, task count expansion, and output aggregation.
- **Single output** (`single-output.test.ts`): Tests solo-agent output file path resolution and instruction injection.
- **Worktree** (`worktree.test.ts`): Tests conflict detection for task-level cwd overrides.
- **Types fork preamble** (`types-fork-preamble.test.ts`): Tests `wrapForkTask` preamble wrapping and idempotency.
- **Prompt template bridge** (`prompt-template-bridge.test.ts`): Tests bridge routing (single vs parallel).
- **Model fallback** (`model-fallback.test.ts`): Tests candidate resolution, retryable error matching, and fallback note formatting.
- **Intercom bridge** (`intercom-bridge.test.ts`): Tests bridge activation rules and prompt/tool injection into agent configs.

## Integration Tests

Loader-based tests in `test/integration/`. They use `createMockPi()` from `test/support/helpers.ts` and skip gracefully if pi packages are unavailable.

Key integration test areas:

- **Chain execution** (`chain-execution.test.ts`): Sequential chain pipeline, template resolution, `{previous}` passing.
- **Parallel execution** (`parallel-execution.test.ts`): Concurrent task dispatching, output aggregation, `count` expansion.
- **Single execution** (`single-execution.test.ts`): Single-agent run with sync process spawning.
- **Async execution** (`async-execution.test.ts`): Background execution launch, status file writing.
- **Async status** (`async-status.test.ts`): Run listing, state formatting.
- **Fork context execution** (`fork-context-execution.test.ts`): Fork branching, preamble injection.
- **Slash commands** (`slash-commands.test.ts`): Command parsing, per-step task splitting, inline override parsing.
- **Slash live state** (`slash-live-state.test.ts`): Versioned snapshot creation and retrieval.
- **Template resolution** (`template-resolution.test.ts`): Chain variable substitution with `{task}`, `{previous}`, `{chain_dir}`.
- **Detect error** (`detect-error.test.ts`): Error extraction from JSONL event streams.
- **Error handling** (`error-handling.test.ts`): Graceful degradation on spawn failure, unknown agent, missing model.
- **Result watcher** (`result-watcher.test.ts`): File-watch trigger and result loading.
- **Subagents status** (`subagents-status.test.ts`): Overlay rendering and run listing.
- **Render fork badge** (`render-fork-badge.test.ts`): Fork context badge display in results.

## End-to-End Tests

Sandbox tests in `test/e2e/` that install the extension into an isolated pi environment.

- **Sandbox install** (`e2e-sandbox-install.test.ts`): Extension install/remove cycle validation.
- **Sandbox** (`e2e-sandbox.test.ts`): Full end-to-end agent execution in a sandboxed pi instance.
- **Tool** (`e2e-tool.test.ts`): Tool parameter validation and result schema conformance.

## Test Support

`test/support/helpers.ts` provides the core test infrastructure for integration tests.

It exports: `createMockPi()` (mock pi API with tool registration, event bus, and session manager), `makeAgent()` (minimal `AgentConfig`), `makeMinimalCtx()` (minimal `ExtensionContext`), `createTempDir()`/`removeTempDir()`, and `tryImport()` (graceful import returning null on failure).
