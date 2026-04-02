# Skills

Skills are reusable instruction fragments from `SKILL.md` files injected into agent system prompts as `<skill name="...">...</skill>` XML blocks.

## Skill Resolution

`resolveSkills` in [[skills.ts]] takes skill names and the working directory, then searches for matching `SKILL.md` files across all discovery paths in priority order (project > user).

Resolution results are cached by file mtime to avoid redundant disk reads. Missing skills are returned in a separate `missing` array — they produce a warning but never abort execution.

## Discovery Paths

Skills are discovered from six locations (project sources take precedence over user sources):

1. Project: `.pi/skills/{name}/SKILL.md`
2. Project packages: `.pi/npm/node_modules/*` via `package.json → pi.skills`
3. Project settings: `.pi/settings.json → skills`
4. User: `~/.pi/agent/skills/{name}/SKILL.md`
5. User packages: `~/.pi/agent/npm/node_modules/*` via `package.json → pi.skills`
6. User settings: `~/.pi/agent/settings.json → skills`

## Injection Format

`buildSkillInjection` in [[skills.ts]] concatenates all resolved skill contents (stripping each file's own frontmatter) and wraps each in an XML block:

```xml
<skill name="safe-bash">
[SKILL.md body, frontmatter removed]
</skill>
```

The injected block is appended to the agent's system prompt, separated by a blank line.

## Runtime Override

The `skill` parameter on any tool call or chain step replaces the agent's frontmatter skill list entirely.

Setting `skill: false` disables all skills for that run, including agent defaults. Chain-level skills are additive to step-level skills. Accepts string (comma-separated), array, or boolean.

## Normalization

`normalizeSkillInput` in [[skills.ts]] accepts string (comma-separated), string array, boolean, or null and returns a canonical `string[] | false`. This ensures uniform handling across all call sites.
