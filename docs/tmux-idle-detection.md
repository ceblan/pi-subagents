# Tmux Idle Detection — Investigación y Diseño de Implementación

**Objetivo:** Detectar cuando un subagente corriendo en un pane tmux (modo interactivo) está idle durante un período X y decretar automáticamente que ha terminado, devolviendo el control a la sesión padre.

**Fecha:** 2026-04-02  
**tmux versión probada:** 3.6a

---

## 1. Contexto: el problema con el modo tmux interactivo

En `execution.ts`, `runSyncTmux()` hace lo siguiente:

```typescript
// Lanza pi en un pane tmux
await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig);

// Solo cuando el pane CIERRA, parsea el resultado
const sessionResult = parseSessionDir(sessionDir);
```

Y en `tmux.ts`, `waitForPaneExit()` hace polling cada 500ms:

```typescript
export function waitForPaneExit(paneId: string, pollMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (!paneExists(paneId)) { resolve(true); return; }
      setTimeout(check, pollMs);
    };
    check();
  });
}
```

En modo `interactive: true`, pi no termina solo — el usuario tiene que escribir `/exit` o `Ctrl+C`. El padre espera indefinidamente. **No hay timeout ni detección de idle.**

---

## 2. Mecanismos tmux investigados experimentalmente

Se probaron tres estrategias con tmux 3.6a.

### 2.1 `monitor-silence` + hook `alert-silence` ✅ Funciona, limitado

tmux tiene la window option `monitor-silence [interval]` que detecta inactividad de **output** en un window. Cuando expira, dispara el hook `alert-silence`.

**Prueba realizada:**
```bash
# Crear window para el subagente
AGENT_WIN=$(tmux new-window -d -P -F '#{window_id}' -n "pi-subagent" "bash -c '...'")

	# Activar detección de silencio de 5 segundos
tmux set-window-option -t "$AGENT_WIN" monitor-silence 5

# Hook: cuando haya silencio, escribir señal en archivo
tmux set-hook -t "$AGENT_WIN" alert-silence \
  "run-shell 'echo #{window_id} > /tmp/silence.signal'"
```

**Resultado:** ✅ La señal llega con precisión de ~1 segundo extra sobre el threshold.

**Limitación crítica para pi TUI:** El TUI de pi genera **output de UI continuo** (cursor, status bar, rerenders). Esto resetea el contador de silencio constantemente, aunque el LLM haya terminado de responder. Por tanto, `monitor-silence` detecta "no hay output de terminal" no "el LLM terminó de hablar" — son cosas diferentes en pi interactivo.

**Requerimiento adicional:** `monitor-silence` es una **window option**, no de pane. Si el subagente corre en un split-window del mismo window que el padre, la actividad del padre resetea el timer. Requiere `new-window` para el subagente.

### 2.2 Polling de `window_activity` ⚠️ Funciona, misma limitación

La variable de formato `#{window_activity}` de tmux expone el timestamp Unix de la última actividad del window. Se puede consultar via:

```bash
tmux display-message -p -t "$AGENT_WIN" '#{window_activity}'
# → 1775151285 (Unix timestamp)
```

**Prueba realizada:** Polling cada 500ms, threshold 3s → detección correcta cuando para el output.

**Misma limitación:** Detecta inactividad de **output de terminal**, no semántica del LLM. El TUI de pi genera ruido continuo.

### 2.3 Monitoreo del session JSONL de pi ✅✅ Fiable y semánticamente exacto

Esta es la **estrategia correcta** para pi. Se basa en:

**Cómo pi escribe el session file** (verificado en `session-manager.js`):
```javascript
// pi escribe en el session file SÍNCRONAMENTE con appendFileSync
// Solo cuando recibe event "message_end" (mensaje COMPLETO, no delta por delta)
_persist(entry) {
  // ...
  appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
}
```

**Cuándo se actualiza el mtime del session JSONL:**

| Evento | mtime cambia |
|--------|-------------|
| LLM generando tokens (streaming) | ❌ NO |
| LLM termina mensaje assistant (message_end) | ✅ SÍ |
| Pi ejecuta herramienta (tool result) | ✅ SÍ |
| TUI refresca cursor/status bar | ❌ NO |
| Usuario escribe en el TUI | ❌ NO |

**El session JSONL ignora completamente el ruido de TUI.** Solo refleja la semántica de los mensajes del agente.

**Estructura del último entry cuando el agente termina:**
```json
{
  "type": "message",
  "timestamp": "2026-04-02T17:13:10.201Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "He completado la tarea..." }
    ]
  }
}
```
→ `role=assistant` + content sin `toolCall` = **el agente terminó su turno, está esperando input del usuario**.

**Comparar con un turno incompleto (hay más herramientas por ejecutar):**
```json
{
  "type": "message",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "..." },
      { "type": "toolCall", "name": "bash", "arguments": {...} }
    ]
  }
}
```
→ Tiene `toolCall` → el agente no ha terminado aún.

---

## 3. Algoritmo de detección de idle

### Señal combinada (más robusta)

La detección más fiable combina:
1. **mtime del session JSONL** — cambió recientemente → el agente está activo  
2. **Análisis del último entry** — `role=assistant` sin `toolCall` → terminó su turno semánticamente

```
IDLE = (mtime sin cambiar > threshold_ms) AND (último entry = assistant sin toolCall)
```

Esta combinación elimina falsos positivos:
- Si el LLM tarda 40 segundos en pensar → mtime no cambia, pero tampoco hay `message_end` registrado → no es idle, es "pensando"
- Si el LLM acaba de hacer tool call → hay entry con `toolCall` → no es idle
- Si el LLM terminó hace 5s → mtime estable + último entry assistant sin toolCall → **SÍ es idle**

### Casos edge

| Situación | mtime | Último entry | Idle? |
|-----------|-------|--------------|-------|
| LLM generando primera respuesta | No existe aún | N/A | No (aún no hay session file) |
| LLM pensando (40s) | Sin cambiar | (no hay aún) | No |
| LLM terminó de responder, en prompt | Sin cambiar | assistant, no toolCall | **SÍ** |
| LLM llamó a herramienta, esperando resultado | Cambió hace poco | toolCall | No |
| LLM generó respuesta tras tool result | Cambió hace poco | assistant | No (mtime reciente) |
| Usuario responde en el TUI | Cambió (user msg) | user | No (hay user message nuevo) |

---

## 4. Diseño de implementación

### 4.1 Cambios en `types.ts`

```typescript
export interface TmuxConfig {
  enabled: boolean;
  split: "vertical" | "horizontal";
  closeOnComplete: boolean;
  focusSubagent: boolean;
  interactive: boolean;
  // NUEVO: detección de idle
  idleTimeoutMs?: number;   // ms de silencio antes de decretar idle (0 = desactivado)
                             // Sugerido: 30_000 (30 segundos)
  idlePollMs?: number;       // intervalo de polling del session file (default: 500)
}
```

### 4.2 Nueva función en `tmux.ts`: `waitForPaneExitOrIdle`

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

export interface TmuxIdleResult extends TmuxPaneResult {
  /** Si true, el pane terminó por idle detection (no por cierre del proceso) */
  idleDetected: boolean;
  /** El session file del subagente en el momento del idle */
  sessionFileAtIdle?: string;
  /** El mtime del session file cuando se detectó idle */
  idleDetectedAt?: number;
}

/**
 * Escanea el sessionDir para encontrar el .jsonl del subagente.
 * Pi nombra el archivo con timestamp+uuid, así que no conocemos el nombre de antemano.
 */
function findSessionFile(sessionDir: string): string | null {
  try {
    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({
        path: path.join(sessionDir, f),
        mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Lee el último entry del session JSONL y determina si el agente terminó su turno.
 * 
 * Devuelve true si:
 * - El último entry es role=assistant
 * - Su content no contiene toolCall
 * (= el agente respondió y no llamó a más herramientas → está esperando input del usuario)
 */
function isAgentIdleInSessionFile(sessionFilePath: string): boolean {
  try {
    const content = fs.readFileSync(sessionFilePath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());
    
    // Buscar el último entry de tipo "message"
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== "message") continue;
        
        const msg = entry.message;
        if (!msg) continue;
        
        // Si el último message es del usuario → el agente aún no ha respondido a esa entrada
        if (msg.role === "user") return false;
        
        // toolResult → el agente está procesando el resultado
        if (msg.role === "toolResult") return false;
        
        // assistant → revisar si tiene tool calls
        if (msg.role === "assistant") {
          const content = Array.isArray(msg.content) ? msg.content : [];
          const hasToolCall = content.some((c: { type?: string }) => 
            c.type === "toolCall" || c.type === "tool_use" || c.type === "toolUse"
          );
          return !hasToolCall; // idle si NO hay tool calls
        }
        
        return false;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Espera hasta que el pane cierre O hasta detectar idle del subagente
 * (basado en inactividad del session JSONL + análisis semántico del último mensaje).
 *
 * @param paneId    ID del pane tmux del subagente
 * @param sessionDir  Directorio donde pi escribe el session .jsonl
 * @param config    TmuxConfig con idleTimeoutMs e idlePollMs
 */
export function waitForPaneExitOrIdle(
  paneId: string,
  sessionDir: string,
  config: TmuxConfig,
): Promise<TmuxIdleResult> {
  const pollMs = config.idlePollMs ?? 500;
  const idleTimeoutMs = config.idleTimeoutMs ?? 0;

  return new Promise((resolve) => {
    let sessionFile: string | null = null;
    let lastMtime = 0;
    let idleSince: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const check = () => {
      // 1. ¿El pane cerró? (el proceso pi terminó normalmente)
      if (!paneExists(paneId)) {
        cleanup();
        resolve({ paneId, completed: true, idleDetected: false });
        return;
      }

      // 2. Detección de idle (solo si idleTimeoutMs > 0)
      if (idleTimeoutMs > 0) {
        // Intentar encontrar el session file si aún no lo tenemos
        if (!sessionFile) {
          sessionFile = findSessionFile(sessionDir);
        }

        if (sessionFile) {
          try {
            const stat = fs.statSync(sessionFile);
            const currentMtime = stat.mtimeMs;

            if (currentMtime !== lastMtime) {
              // Hay actividad reciente → resetear el timer de idle
              lastMtime = currentMtime;
              idleSince = null;
            } else {
              // mtime no cambió
              if (idleSince === null) {
                idleSince = Date.now();
              } else {
                const idleDuration = Date.now() - idleSince;
                if (idleDuration >= idleTimeoutMs) {
                  // El mtime lleva suficiente tiempo sin cambiar
                  // Verificar semánticamente: ¿el último mensaje es assistant sin toolCall?
                  if (isAgentIdleInSessionFile(sessionFile)) {
                    cleanup();
                    resolve({
                      paneId,
                      completed: false,
                      idleDetected: true,
                      sessionFileAtIdle: sessionFile,
                      idleDetectedAt: Date.now(),
                    });
                    return;
                  } else {
                    // Semánticamente no está idle (LLM pensando, tool en curso)
                    // Resetear el timer para dar más tiempo
                    idleSince = null;
                  }
                }
              }
            }
          } catch {
            // El session file puede no existir aún o estar siendo escrito
          }
        }
        // Si no hay session file aún → el LLM no ha respondido todavía, seguir esperando
      }

      timer = setTimeout(check, pollMs);
    };

    // Arrancar el loop
    check();
  });
}
```

### 4.3 Modificar `runInTmuxPane` en `tmux.ts`

```typescript
/**
 * Run a pi subagent in a new tmux pane and wait for it to complete or go idle.
 *
 * Si config.idleTimeoutMs > 0, también devuelve cuando el subagente lleva
 * ese tiempo sin actividad en su session JSONL y su último mensaje es del asistente
 * sin tool calls (= terminó su turno y espera input del usuario).
 *
 * @param sessionDir  Directorio donde pi escribe el session .jsonl
 *                    (el mismo que se pasa con --session-dir al subagente)
 */
export async function runInTmuxPane(
  piArgs: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  config: TmuxConfig,
  sessionDir?: string,   // NUEVO parámetro
): Promise<TmuxPaneResult> {
  const origPane = getCurrentPane();
  const command = buildTmuxShellCommand(piArgs, env, config.closeOnComplete);
  const paneId = openPane(command, cwd, config);

  let result: TmuxIdleResult;

  if (config.idleTimeoutMs && config.idleTimeoutMs > 0 && sessionDir) {
    // Usar la versión con idle detection
    result = await waitForPaneExitOrIdle(paneId, sessionDir, config);
    
    // Si se detectó idle, matar el pane (el usuario terminó su tarea)
    if (result.idleDetected) {
      // Dar un momento para que el usuario vea el resultado antes de cerrar
      // (opcional, configurable)
      if (config.closeOnComplete) {
        await new Promise(r => setTimeout(r, 1000)); // 1s de gracia
        killPane(paneId);
      }
    }
  } else {
    // Comportamiento original: esperar cierre del pane
    const completed = await waitForPaneExit(paneId);
    result = { paneId, completed, idleDetected: false };
  }

  // Devolver foco al pane original si se había movido
  if (config.focusSubagent) {
    focusPane(origPane);
  }

  return result;
}
```

### 4.4 Modificar `runSyncTmux` en `execution.ts`

El cambio mínimo es pasar el `sessionDir` a `runInTmuxPane`:

```typescript
// En runSyncTmux, donde antes era:
await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig);

// Ahora pasa el sessionDir para que pueda monitorear el JSONL:
await runInTmuxPane(args, spawnEnv, effectiveCwd, resolved.tmuxConfig, sessionDir);
```

---

## 5. Configuración de usuario

En `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "tmux": {
    "enabled": true,
    "interactive": true,
    "closeOnComplete": true,
    "focusSubagent": false,
    "split": "vertical",
    "idleTimeoutMs": 30000,
    "idlePollMs": 500
  }
}
```

| Parámetro | Descripción | Recomendado |
|-----------|-------------|-------------|
| `idleTimeoutMs` | ms sin cambios en el session JSONL antes de decretar idle. `0` = desactivado | `30000` (30s) |
| `idlePollMs` | Frecuencia del poll en ms | `500` |

**¿Por qué 30 segundos?** Es un balance entre:
- Tiempo mínimo: los modelos lentos (Claude thinking, DeepSeek) pueden tardar 20-30s entre mensajes
- Tiempo máximo: el usuario no quiere esperar demasiado después de que el subagente termina

Para modelos rápidos, 10-15s puede ser suficiente. Para modelos con thinking extendido, 45-60s es más seguro.

---

## 6. Interacción con el usuario

### Cuando el idle detection activa:

El padre recibe el resultado de `runInTmuxPane` con `idleDetected: true`. Puede entonces:

1. **Cerrar el pane silenciosamente** (si `closeOnComplete: true`) — comportamiento más limpio
2. **Mantener el pane abierto** y mostrar un mensaje ("subagente idle — detectado como completado")
3. **Notificar al usuario** y darle la opción de continuar el subagente o cerrar

Sugerencia: añadir un mensaje visible en el pane antes de cerrarlo:

```typescript
// En tmux.ts, antes de killPane():
if (result.idleDetected && config.closeOnComplete) {
  // Enviar mensaje al pane del subagente (el usuario lo verá brevemente)
  execSync(
    `tmux send-keys -t ${paneId} '' Enter`,  // no-op para no interrumpir
    { stdio: "ignore" }
  );
  await new Promise(r => setTimeout(r, 2000));  // 2s para que el usuario lo vea
  killPane(paneId);
}
```

O mejor, optar por el mecanismo de `closeOnComplete` con delay configurable:

```typescript
export interface TmuxConfig {
  // ...
  idleTimeoutMs?: number;
  idlePollMs?: number;
  idleCloseDelayMs?: number;  // ms de espera antes de cerrar el pane tras idle (default: 0)
}
```

---

## 7. Edge cases y mitigaciones

### 7.1 El subagente está en conversación activa con el usuario

Si el usuario está interactuando con el subagente via el TUI:
- Cada respuesta del usuario genera un `user` message → mtime del JSONL cambia
- El agente responde → `assistant` message → mtime cambia
- El idle timer se resetea en cada intercambio

✅ **No hay falso positivo** — el sistema detecta correctamente que hay actividad.

### 7.2 El LLM está "pensando" (latencia alta)

Si el modelo está generando pero tarda 40 segundos:
- mtime del JSONL no cambia (no hay `message_end` aún)
- El idle timer empieza a contar
- Si el threshold es 30s → falso positivo

**Mitigación:** 
- Usar threshold más alto (≥ 45s para modelos lentos)
- La verificación semántica (`isAgentIdleInSessionFile`) también actúa: si no hay ningún `assistant` message aún, `idleSince` se resetea

⚠️ **Este es el único caso problemático.** La solución es configurar `idleTimeoutMs` según el modelo más lento que se use.

### 7.3 El session file no existe aún

Al principio, antes de que el LLM responda, no hay session JSONL. `findSessionFile` devuelve `null` y el loop simplemente continúa esperando el cierre del pane — comportamiento original.

✅ **Sin problema** — degrada graciosamente al comportamiento anterior.

### 7.4 El subagente falla y el proceso termina con error

Si pi cierra con error, `paneExists` devuelve `false` y se resuelve con `completed: true`. El `parseSessionDir` posterior manejará el error del session file vacío.

✅ **Sin problema** — path de error igual al comportamiento original.

### 7.5 `closeOnComplete: false` (el usuario quiere revisar el output)

Si el usuario configuró `closeOnComplete: false`, el pane se mantiene abierto incluso tras idle detection. El padre devuelve el resultado pero el pane sigue visible. El usuario puede continuar la conversación manualmente.

---

## 8. Diferencia entre `interactive: false` e `interactive: true`

| Modo | Pi flag | Comportamiento | Idle detection necesario |
|------|---------|----------------|--------------------------|
| `interactive: false` | `-p` (print mode) | Pi termina automáticamente | ❌ No (el pane cierra solo) |
| `interactive: true` | (sin flags) | Pi queda en TUI esperando | ✅ **Sí, aquí es donde aplica** |

La idle detection solo tiene sentido con `interactive: true`. En `interactive: false`, pi ya termina cuando acaba la tarea y el pane cierra automáticamente.

---

## 9. Resumen de cambios en el codebase

| Archivo | Cambio |
|---------|--------|
| `types.ts` | Añadir `idleTimeoutMs?` e `idlePollMs?` a `TmuxConfig` |
| `tmux.ts` | Añadir `findSessionFile()`, `isAgentIdleInSessionFile()`, `waitForPaneExitOrIdle()` |
| `tmux.ts` | Modificar `runInTmuxPane()` para aceptar `sessionDir` y usarlo cuando `idleTimeoutMs > 0` |
| `execution.ts` | En `runSyncTmux()`, pasar `sessionDir` a `runInTmuxPane()` |

**Total de cambios:** ~100 líneas de código nuevo + ~10 líneas modificadas. Mínimamente invasivo, completamente retrocompatible (`idleTimeoutMs` es opcional y por defecto `0` = desactivado).

---

## 10. Por qué esta solución es superior a las alternativas tmux

| Enfoque | Señal | ¿Fiable en TUI de pi? | Invasividad |
|---------|-------|----------------------|-------------|
| `monitor-silence` tmux | Output de terminal | ❌ Ruido TUI | Requiere `new-window` |
| `window_activity` polling | Output de terminal | ❌ Ruido TUI | Polling tmux |
| **Session JSONL mtime + semántica** | Mensajes del agente | ✅ Exacto | Solo polling de archivo |

El session JSONL es la única fuente de verdad semántica sobre el estado del agente. Es **inmune al ruido del TUI** porque pi solo escribe en él cuando hay un mensaje LLM completo (`message_end`), no cuando refresca la pantalla.
