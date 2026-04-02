# Plan de implementación: Tmux Idle Detection

**Basado en:** `docs/tmux-idle-detection.md`  
**Scope:** Detectar idle en subagentes tmux interactivos via session JSONL + devolver control al padre  
**Estimación:** ~100 líneas nuevas, ~10 modificadas, 4 archivos

---

## Tareas

### 1. `types.ts` — Añadir campos a `TmuxConfig` y extender `TmuxPaneResult`

**Qué:** Dos nuevos campos opcionales en `TmuxConfig` y un nuevo tipo `TmuxIdleResult`.

**Cambios exactos:**

En `TmuxConfig`, añadir después de `interactive`:
```typescript
/** ms of session JSONL inactivity before declaring idle (0 = disabled). Only applies when interactive=true. */
idleTimeoutMs?: number;
/** Polling interval in ms for session file mtime checks (default: 500) */
idlePollMs?: number;
```

En `DEFAULT_TMUX_CONFIG`, añadir:
```typescript
idleTimeoutMs: 0,    // disabled by default
idlePollMs: 500,
```

**No se necesita** tipo `TmuxIdleResult` en types.ts — se define localmente en tmux.ts ya que solo lo consume `execution.ts` via el export de tmux.ts.

---

### 2. `tmux.ts` — Tres nuevas funciones + modificar `runInTmuxPane`

**2a. Función `findSessionFile(sessionDir): string | null`**

Escanea el directorio buscando el `.jsonl` más reciente por mtime. Pi nombra los session files con timestamp+uuid, así que no conocemos el nombre de antemano.

```typescript
function findSessionFile(sessionDir: string): string | null {
  // fs.readdirSync → filtrar *.jsonl → sort por mtime desc → return [0]
}
```

> Nota: ya existe `findLatestSessionFile` en `utils.ts`. Evaluar reusar directamente esa. Si la signatura es compatible (`(dir: string) => string | null`), importarla en vez de duplicar.

**2b. Función `isAgentIdleInSessionFile(filePath): boolean`**

Lee el archivo, busca el último entry `type: "message"`, y devuelve `true` si:
- `role === "assistant"` AND
- `content` no contiene ningún item con `type === "toolCall"` (ni `"tool_use"` ni `"toolUse"`)

Devuelve `false` si el último message es `user` (el agente aún no respondió) o `toolResult` (hay herramienta en curso), o si no hay entries.

**2c. Función `waitForPaneExitOrIdle(paneId, sessionDir, config): Promise<TmuxIdleResult>`**

Tipo de retorno (exportado):
```typescript
export interface TmuxIdleResult extends TmuxPaneResult {
  idleDetected: boolean;
  sessionFileAtIdle?: string;
}
```

Loop de polling con intervalo `config.idlePollMs ?? 500`:
1. Si `!paneExists(paneId)` → resolve `{ completed: true, idleDetected: false }`
2. Si `idleTimeoutMs > 0`:
   - Buscar session file (cache resultado tras primera localización)
   - Leer `stat.mtimeMs` del session file
   - Si mtime cambió → resetear `idleSince = null`
   - Si mtime estable y `Date.now() - idleSince >= idleTimeoutMs`:
     - Llamar `isAgentIdleInSessionFile()`
     - Si `true` → resolve `{ completed: false, idleDetected: true, sessionFileAtIdle }`
     - Si `false` → resetear `idleSince` (LLM pensando, no es idle real)

**2d. Modificar `runInTmuxPane`**

Añadir parámetro opcional `sessionDir?: string`. Si `config.idleTimeoutMs > 0` y `sessionDir` está presente, usar `waitForPaneExitOrIdle` en vez de `waitForPaneExit`.

Cuando `idleDetected === true` y `config.closeOnComplete === true`, llamar `killPane(paneId)` para cerrar el pane del subagente.

Signatura actual:
```typescript
export async function runInTmuxPane(
  piArgs: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  config: TmuxConfig,
): Promise<TmuxPaneResult>
```

Signatura nueva:
```typescript
export async function runInTmuxPane(
  piArgs: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  config: TmuxConfig,
  sessionDir?: string,
): Promise<TmuxPaneResult>
```

El tipo de retorno sigue siendo `TmuxPaneResult` (que es supertype de `TmuxIdleResult`). El caller en `execution.ts` no necesita distinguir — siempre parsea el session dir al final.

---

### 3. `execution.ts` — Pasar `sessionDir` a `runInTmuxPane`

**Cambio de una línea** en `runSyncTmux()`:

```diff
- await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig);
+ await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig, sessionDir);
```

La variable `sessionDir` ya existe en scope (se define 10 líneas arriba). No se necesita ningún otro cambio — `parseSessionDir(sessionDir)` ya se llama después y funcionará igual independientemente de si el pane cerró por exit normal o por idle detection.

---

### 4. Tests — Nuevo archivo `test/unit/tmux-idle-detection.test.ts`

Tests unitarios para las dos funciones puras (`isAgentIdleInSessionFile`, `findSessionFile`) y para `waitForPaneExitOrIdle` con mocks del filesystem.

**Tests para `isAgentIdleInSessionFile`:**

| Test | Session JSONL content | Expected |
|------|-----------------------|----------|
| Último entry assistant sin toolCall | `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}` | `true` |
| Último entry assistant con toolCall | `{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash"}]}}` | `false` |
| Último entry user | `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hola"}]}}` | `false` |
| Último entry toolResult | `{"type":"message","message":{"role":"toolResult","content":[...]}}` | `false` |
| Archivo vacío | `` | `false` |
| Archivo inexistente | N/A | `false` |
| Múltiples entries, último es assistant idle | assistant+toolCall → toolResult → assistant sin toolCall | `true` |
| Entry no-message al final (model_change) | `...assistant_idle → {"type":"model_change",...}` | `true` (ignora non-message, busca último message) |

**Tests para `waitForPaneExitOrIdle`:**

Estos requieren mockear `paneExists` y el filesystem. Usar `createTempDir()` con archivos JSONL reales:

| Test | Setup | Expected |
|------|-------|----------|
| Pane cierra antes de idle timeout | paneExists=false en primer check | `{ completed: true, idleDetected: false }` |
| Idle detectado tras timeout | Session file con assistant idle, mtime estable > timeout | `{ completed: false, idleDetected: true }` |
| No idle si session file cambia | Tocar mtime del archivo en cada poll | Nunca resuelve idle (timeout test con abort) |
| No idle si último entry es toolCall | Session file con toolCall, mtime estable > timeout | `idleSince` se resetea, no resuelve idle |
| idleTimeoutMs=0 desactiva idle detection | Config con 0 | Solo resuelve por pane exit |

---

## Orden de ejecución

```
1. types.ts          (tipos, 0 riesgo)
2. tmux.ts           (funciones nuevas + modificación de runInTmuxPane)
3. execution.ts      (1 línea)
4. tests             (validar)
```

## Compatibilidad

- **Retrocompatible al 100%:** `idleTimeoutMs` default es `0` (desactivado). Sin configuración explícita, el comportamiento es idéntico al actual.
- **`interactive: false` no se ve afectado:** Pi termina solo con `-p`, el pane cierra, `waitForPaneExit` resuelve normalmente.
- **`sessionDir` opcional en `runInTmuxPane`:** Si no se pasa, se usa `waitForPaneExit` original.

## Notas de implementación

- `findLatestSessionFile` ya existe en `utils.ts` con la signatura `(dir: string) => string | null`. Reusar directamente en vez de crear `findSessionFile` duplicada.
- `isAgentIdleInSessionFile` debe tolerar archivos parcialmente escritos (última línea truncada). El `try/catch` por línea del `JSON.parse` ya maneja esto — mismo patrón que `session-parser.ts`.
- El poll timer en `waitForPaneExitOrIdle` debe usar `setTimeout` recursivo (no `setInterval`) para evitar acumulación si un check tarda más que `pollMs`. Mismo patrón que `waitForPaneExit` actual.
