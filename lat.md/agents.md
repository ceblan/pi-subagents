# Agents

Agents are markdown files with YAML frontmatter that define specialized AI configurations — model, tools, system prompt, skills, and chain behavior defaults.

## Agent Config

An `AgentConfig` (defined in [[agents.ts]]) captures the parsed state of an agent file.

Fields include `name`, `description`, `model`, `fallbackModels`, `thinking`, `tools`, `mcpDirectTools`, `systemPrompt`, `skills`, `extensions`, `output`, `defaultReads`, `defaultProgress`, `interactive`, `maxSubagentDepth`, and `source`. The `source` field is one of `"builtin"`, `"user"`, or `"project"`.

## Agent Scopes

Agents exist in three scopes with priority order (project wins on name collision):

| Scope | Path |
|-------|------|
| Builtin | `~/.pi/agent/extensions/subagent/agents/` |
| User | `~/.pi/agent/agents/{name}.md` and `~/.agents/{name}.md` |
| Project | `.pi/agents/{name}.md` or `.agents/{name}.md` (walks up directory tree) |

Scope resolution is implemented in [[agent-scope.ts]] and [[agent-selection.ts#mergeAgentsForScope]]. The `agentScope` parameter (default `"both"`) controls which scopes are searched.

## Builtin Agents

Seven builtin agents ship with the extension: `scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, and `delegate`.

They load at lowest priority (marked `source: "builtin"`) and cannot be modified via management actions. Create a user or project agent with the same name to override a builtin.

## Chain Config

Chains are `.chain.md` files adjacent to agent files. A `ChainConfig` (from [[agents.ts]]) holds `name`, `description`, `source`, `filePath`, and `steps: ChainStepConfig[]`.

Each step has `agent`, `task`, and optional `output`, `reads`, `model`, `skills`, `progress` fields. Parsing logic lives in [[chain-serializer.ts]].

## Discovery

`discoverAgents` in [[agents.ts]] returns all agents and chains from all active scopes.

It reads `.md` files (skipping `.chain.md`), parses YAML frontmatter via [[frontmatter.ts]], and validates required `name` and `description` fields. Chain files are parsed by `parseChain`. Agents without valid frontmatter are silently skipped.

## MCP Tool Integration

Agent frontmatter `tools` entries prefixed with `mcp:` are separated into `mcpDirectTools` during parsing.

These are only activated when the `pi-mcp-adapter` extension is present. Regular tool names and MCP tool names are stored separately to keep the resolution paths clean.

## Extension Sandboxing

The `extensions` frontmatter field controls which extensions load in the subagent:

- Field absent → all extensions load (default)
- Empty value → `--no-extensions`
- CSV list of absolute paths → `--no-extensions --extension <path> ...`

When `extensions` is present, it takes precedence over `mcp:` tool entries for extension loading.

## Fallback Models

Agents can declare `fallbackModels` as a comma-separated list of backup models in frontmatter.

At runtime, [[execution.ts]] builds a deduplicated candidate list from `model` + `fallbackModels`, then retries only on provider/model availability failures detected by [[model-fallback.ts#isRetryableModelFailure]].

## Thinking Level

The `thinking` frontmatter field accepts: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

Applied by `applyThinkingSuffix` in [[pi-args.ts]] which appends `:level` to the model string. If the model already has a `:suffix`, the agent's default is not double-applied.

## Skill Declaration

Agents declare default skills via `skill:` in frontmatter (comma-separated). At runtime, skills are resolved and injected into the system prompt. See [[skills#Skill Resolution]].

## Management Actions

The LLM can call the `subagent` tool with `action:` set to `list`, `get`, `create`, `update`, or `delete`.

These are handled by [[agent-management.ts#handleManagementAction]]. Management actions operate on files: create writes a new `.md` or `.chain.md`, update merges into the existing file, and delete removes it. Newly created agents are immediately usable without restarting.

## Agent Serializer

[[agent-serializer.ts]] converts an `AgentConfig` back to markdown with YAML frontmatter. The constant `KNOWN_FIELDS` now includes execution-related fields like `fallbackModels`, `interactive`, and `maxSubagentDepth`, while unknown fields round-trip as `extraFields`.
