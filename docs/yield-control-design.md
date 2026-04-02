# Yield Control — Design Document

**Feature:** Devolver el control de la sesión padre cuando el subagente está idle, ha completado su tarea, o está esperando input del usuario.

**Fecha:** 2026-04-02  
**Estado:** Propuesta / Análisis de viabilidad

---

## 1. Estado actual — Cómo bloquea la sesión padre

### 1.1 Modo headless JSON (el path más común)

En `execution.ts`, `runSync()` lanza el proceso hijo con `spawn()` y luego bloquea:

```typescript
// execution.ts ~línea 130
const exitCode = await new Promise<number>((resolve) => {
  const proc = spawn(spawnSpec.command, spawnSpec.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // ...procesa events JSONL hasta que el proceso cierra
  proc.on("close", (code) => {
    resolve(code ?? 0);   // ← única salida del Promise
  });
});
```

**El padre no puede hacer nada hasta que `proc.close` dispara.** El tool `subagent` es una herramienta async de pi: la sesión padre no puede recibir otro turno del LLM ni interactuar con el usuario mientras este Promise no resuelva.

### 1.2 Modo tmux TUI

En `tmux.ts`, `waitForPaneExit()` hace polling de 500ms hasta que el pane desaparece:

```typescript
// tmux.ts
const completed = await waitForPaneExit(paneId);  // bloquea hasta que el pane cierra
```

Aunque el pane es visible para el usuario y puede hacer cosas, el padre sigue esperando el cierre del pane antes de devolver el resultado del tool.

### 1.3 Modo async (parcialmente resuelto)

Con `async: true`, el subagente se lanza como proceso **detached** (`proc.unref()`) y el tool retorna inmediatamente con un `asyncId`. El padre puede continuar. La compleción se notifica via `result-watcher.ts` (`fs.watch` sobre `RESULTS_DIR`).

**Este modo ya implementa un form de yield.** Sin embargo tiene limitaciones importantes:
- El padre no puede inyectar input al subagente
- No hay mecanismo de "pausa y reanuda"
- El subagente no puede preguntar algo al usuario a través del padre

---

## 2. Definición de "idle / waiting"

Para implementar yield control necesitamos identificar con precisión tres estados distintos del subagente:

### Estado A: Subagente completado

**Señal inequívoca:** `proc.on("close")` en el proceso hijo (headless) o desaparición del pane tmux.

En el JSONL stream, el patrón para una ejecución completa es:
```
message_end  (role=assistant, sin tool_calls en el content)
← proceso cierra con exit code 0
```

### Estado B: Subagente esperando input del usuario

Este es el estado más difícil de detectar. Ocurre cuando el LLM produce un `message_end` **sin tool calls** pero el proceso **no cierra** — lo que implicaría que pi está en modo interactivo esperando respuesta del usuario.

En modo headless (`--mode json -p`), pi nunca debería quedarse esperando input — el flag `-p` le dice a pi que es un prompt único y debe terminar. **Por lo tanto, en modo headless este estado no puede ocurrir con la invocación actual.**

En modo tmux con `interactive: true`, el usuario puede hablar con el subagente directamente en el pane tmux. El pane permanece abierto hasta que el usuario escribe `/exit`. Aquí sí ocurre "waiting for user input."

### Estado C: Subagente idle (sin actividad)

El subagente está corriendo (`proc` vivo) pero no emite eventos JSONL durante un período prolongado. Posibles causas:
- Herramienta de larga duración (compilación, build, tests pesados)
- El LLM está pensando (generando tokens — no emite JSONL hasta `message_end`)
- Deadlock o hang

**Distinguir "idle-legítimo" de "idle-problemático" es inherentemente heurístico** y propenso a falsos positivos.

### Tabla de señales disponibles

| Señal | Fuente | Confiabilidad | Modo disponible |
|-------|--------|---------------|-----------------|
| `proc.on("close")` | Node process | Alta | Headless, async |
| `message_end` sin tool_calls | JSONL stream | Media | Headless |
| `tool_execution_start/end` | JSONL stream | Alta | Headless |
| Timeout sin events | Heurístico | Baja | Headless |
| Desaparición del pane | tmux polling | Alta | Tmux |
| `status.json` state=complete | Filesystem | Alta | Async |
| `events.jsonl` step.completed | Filesystem | Alta | Async |

---

## 3. Mecanismos propuestos

### 3.1 Modo headless JSON — Yield por "idle detection"

#### 3.1.1 Yield on completion (fácil, ya casi implementado)

La señal más limpia es `message_end` seguida de **N ms sin `tool_execution_start`**. Esto indica que el LLM ha terminado su turno y no va a llamar a más herramientas.

```typescript
// En execution.ts, dentro de processLine():
if (evt.type === "message_end" && evt.message) {
  // Si es assistant message sin tool calls, iniciar timer de yield
  const hasToolCalls = evt.message.content?.some(c => c.type === "toolCall");
  if (!hasToolCalls && evt.message.role === "assistant") {
    // Arrancar timer de "probable completion"
    yieldTimer = setTimeout(() => {
      // El proceso no ha emitido más events → muy probablemente completado
      // Podemos: (a) enviar señal al padre, (b) abortar el proceso
    }, YIELD_IDLE_TIMEOUT_MS); // ej: 2000ms
  }
}

if (evt.type === "tool_execution_start") {
  // Cancelar el timer — sigue trabajando
  if (yieldTimer) clearTimeout(yieldTimer);
}
```

**Limitación crítica:** En modo `--mode json -p`, cuando el LLM termina sin tool calls, pi **debería** cerrar el proceso solo. El timer sería redundante. El verdadero problema es si queremos yield _antes_ del cierre (para continuar antes de que pi haga cleanup).

#### 3.1.2 Yield on "waiting for prompt" — requiere cambio de protocolo

Para que el subagente pueda explícitamente señalar que está esperando input, necesitamos un nuevo evento JSONL:

```jsonl
{"type": "yield_control", "reason": "waiting_for_user_input", "prompt": "¿Qué directorio de destino prefieres?", "ts": 1234567890}
```

El padre, al detectar este evento, pausaría la espera del proceso hijo y devolvería el resultado parcial al LLM padre para que éste pueda preguntar al usuario.

**Requiere cambios en pi core** (el proceso pi hijo tendría que emitir este nuevo tipo de evento). Está fuera del alcance de este repositorio sin modificar `@mariozechner/pi-coding-agent`.

#### 3.1.3 Yield basado en stdin injection

Alternativamente, en lugar de matar o pausar el proceso hijo, el padre podría **escribir en su stdin** para proporcionar la respuesta que el subagente necesita. Esto requeriría:

1. Cambiar `stdio: ["ignore", "pipe", "pipe"]` → `stdio: ["pipe", "pipe", "pipe"]`
2. Protocolo para que el subagente escriba su pregunta en stdout (evento especial)
3. El padre cierra su loop de espera, pregunta al LLM/usuario, y escribe la respuesta en `proc.stdin`

**Ventaja:** No requiere matar el proceso. **Desventaja:** Pi en modo headless no tiene mecanismo de "pausar y esperar stdin" — consume el prompt inicial y termina.

### 3.2 Modo tmux — Yield natural

El modo tmux con `interactive: true` ya implementa conceptualmente el yield: el subagente vive en un pane separado y el usuario puede interactuar con él directamente. El padre espera el cierre del pane.

Para un yield más granular (padre notificado de completión antes del cierre manual del pane):

```typescript
// tmux.ts — watchSessionFile + yield on completion
async function runInTmuxPaneWithYield(
  piArgs: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  config: TmuxConfig,
  sessionDir: string,
  onYield?: (reason: YieldReason, output: string) => Promise<void>,
): Promise<TmuxPaneResult> {
  const origPane = getCurrentPane();
  const command = buildTmuxShellCommand(piArgs, env, config.closeOnComplete);
  const paneId = openPane(command, cwd, config);

  // En lugar de solo esperar el cierre del pane,
  // también vigilar el session file en tiempo real
  const sessionWatcher = watchSessionFileForCompletion(sessionDir, async (finalOutput) => {
    if (onYield) {
      await onYield({ type: "completed", output: finalOutput });
    }
  });

  const completed = await waitForPaneExit(paneId);
  sessionWatcher.stop();
  
  if (config.focusSubagent) focusPane(origPane);
  return { paneId, completed };
}
```

`watchSessionFileForCompletion` haría `fs.watch` sobre el session `.jsonl` y detectaría cuándo aparece el último mensaje del asistente sin tool calls pendientes.

### 3.3 Modo async — Extensión del status polling

El modo async ya casi tiene yield funcional. El `result-watcher.ts` detecta cuando aparece `{runId}.json` en `RESULTS_DIR` y emite `subagent:complete`.

Para añadir yields intermedios (ej: "el subagente terminó el paso 2 y espera aprobación"), el subagent-runner podría escribir un evento especial en `events.jsonl`:

```jsonl
{"type": "subagent.yield", "ts": ..., "runId": "...", "reason": "awaiting_approval", "prompt": "¿Continuar con la eliminación de 47 archivos?", "stepIndex": 2}
```

Y `async-job-tracker.ts` lo leería durante su poll de 250ms:

```typescript
// async-job-tracker.ts — en el poller interval
const events = readNewEvents(job.asyncDir);
for (const ev of events) {
  if (ev.type === "subagent.yield") {
    // Pausar el subagente (via señal SIGSTOP o archivo lock)
    // Notificar al padre para que pueda preguntar al usuario
    pi.events.emit("subagent:yield", { asyncId: job.asyncId, ...ev });
  }
}
```

---

## 4. Protocolo de yield — Explícito vs Heurístico

### 4.1 Yield explícito (preferido)

El subagente emite una señal estructurada que el padre consume. Ventajas:
- Sin falsos positivos
- Semántica clara (completado vs esperando vs preguntando)
- El subagente controla exactamente cuándo cede

**Implementación en modo headless:** Nuevo tipo de evento JSONL `yield_control`:
```typescript
// Añadir a processLine() en execution.ts:
if (evt.type === "yield_control") {
  const yieldEvent: YieldEvent = {
    reason: evt.reason,        // "task_complete" | "awaiting_input" | "checkpoint"
    prompt: evt.prompt,        // Pregunta opcional al usuario
    output: getFinalOutput(result.messages),
    partialResult: { ...result },
  };
  // Resolver el Promise con YieldEvent en lugar de esperar proc.close
  yieldResolve(yieldEvent);
}
```

**Limitación:** Requiere que el proceso `pi` hijo emita este evento. Necesita modificar `@mariozechner/pi-coding-agent` o un mecanismo de extensión dentro del subagente (una herramienta `yield_control` que el agente puede llamar).

#### Herramienta `yield_control` para agentes

Una forma de implementar yield explícito **sin modificar pi core** es registrar una herramienta especial que el subagente puede invocar:

```typescript
// En el systemPrompt del agente o como herramienta inyectada:
{
  name: "yield_to_parent",
  description: "Cede el control de vuelta a la sesión padre. Úsala cuando necesites input del usuario o cuando hayas completado una fase.",
  parameters: { 
    reason: { type: "string", enum: ["task_complete", "awaiting_input", "checkpoint"] },
    message: { type: "string", description: "Mensaje para el padre" }
  },
  execute: async (params) => {
    // Escribe en un archivo especial que el padre monitorea
    fs.writeFileSync(yieldSignalPath, JSON.stringify(params));
    // Espera hasta que el padre escriba la respuesta
    return await waitForParentResponse(yieldSignalPath + ".response");
  }
}
```

El padre monitorea `yieldSignalPath` con `fs.watch` y, cuando aparece, puede suspender su espera, preguntar al usuario, y escribir la respuesta.

### 4.2 Yield heurístico (fallback)

Basado en timeouts e inactividad. Solo recomendado como safety net:

```typescript
const YIELD_IDLE_MS = 30_000; // 30 segundos sin actividad → yield por timeout

let lastActivityMs = Date.now();
let idleTimer: NodeJS.Timeout | null = null;

const resetIdleTimer = () => {
  lastActivityMs = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  if (options.yieldOnIdle) {
    idleTimer = setTimeout(() => {
      // Sin actividad por YIELD_IDLE_MS → yield
      fireIdleYield();
    }, YIELD_IDLE_MS);
  }
};

// En processLine(): llamar resetIdleTimer() en cada evento
```

**Problema principal:** Los LLMs tienen latencia variable. Un modelo lento pensando puede parecer idle durante 20-30 segundos. El threshold es imposible de calibrar universalmente.

---

## 5. Qué significa "devolver control"

Hay tres interpretaciones, de menor a mayor complejidad:

### Nivel 1: Notificación (no-blocking async)

El padre recibe una notificación de que el subagente terminó/está idle, pero ya estaba haciendo otras cosas. Esto es básicamente el **modo async actual**, mejorado con eventos de yield intermedios.

**Cambio necesario:** Minimal. Añadir eventos `subagent:yield` en `pi.events` y que `async-job-tracker.ts` los emita.

### Nivel 2: Coroutine cooperativa

El padre está bloqueado esperando al subagente. Cuando el subagente hace yield, el padre "despierta", puede preguntar al usuario o al LLM padre, y luego "reanuda" el subagente con la respuesta.

```
Padre (tool call bloqueado)    Subagente (proceso hijo)
       │                              │
       │←── yield_event ─────────────│
       │                              │  (pausa en el archivo lock)
       │ [pregunta al usuario]        │
       │ [obtiene respuesta]          │
       │──── resume(respuesta) ──────→│
       │                              │  (continúa ejecución)
       │←── proc.close ──────────────│
```

**Cambio necesario:** Medio. Requiere mecanismo de lock/signal para pausar el subagente, y el padre debe poder inyectar la respuesta.

### Nivel 3: Multi-agent conversation (más ambicioso)

El subagente puede "escalar" preguntas al padre en cualquier momento durante su ejecución, y el padre puede responder como si fuera el usuario. Requiere un canal bidireccional de comunicación entre sesiones de pi.

**Cambio necesario:** Grande. Requiere protocolo de IPC entre procesos pi, posiblemente un bus de mensajes.

---

## 6. Flujo de datos para resume

Para el Nivel 2 (coroutine cooperativa), el flujo de datos sería:

```
┌─────────────────────────────────────────────────────────────┐
│ execution.ts (padre bloqueado en runSync)                   │
│                                                             │
│  proc = spawn("pi", args, { stdin: "pipe" })               │
│                                                             │
│  proc.stdout → processLine()                               │
│    → detecta {"type":"yield_control","prompt":"..."}        │
│    → emite yieldCallback(yieldEvent)                        │
│    → proc.stdin.pause() o envía SIGSTOP                     │
│                                                             │
│  yieldCallback en el padre:                                 │
│    → retorna result parcial al LLM padre                    │
│    → LLM padre pregunta al usuario o decide autónomamente   │
│    → padre escribe respuesta en proc.stdin                  │
│    → proc continúa ejecutando                               │
│                                                             │
│  proc.on("close") → resolve con result final               │
└─────────────────────────────────────────────────────────────┘
```

### Cambios en la signatura de `runSync`

```typescript
// types.ts — nuevas interfaces
export interface YieldEvent {
  reason: "task_complete" | "awaiting_input" | "checkpoint";
  prompt?: string;           // Pregunta del subagente al padre/usuario
  partialOutput: string;     // Output generado hasta ahora
  canResume: boolean;        // Si el padre puede enviar respuesta
}

export interface YieldedExecution {
  yieldEvent: YieldEvent;
  resume: (response: string) => Promise<SingleResult>;  // Callback para reanudar
  abort: () => void;         // Cancelar el subagente
}

// RunSyncOptions — nueva opción
export interface RunSyncOptions {
  // ...existentes...
  onYield?: (yielded: YieldedExecution) => void;  // Callback cuando el subagente hace yield
}
```

### Mecanismo de pausa/resume via filesystem

Para evitar depender de `SIGSTOP`/`SIGCONT` (que no funciona en Windows), se puede usar un archivo lock:

```typescript
// Subagente (herramienta yield_to_parent):
const lockPath = path.join(asyncDir, "yield.lock");
const responsePath = path.join(asyncDir, "yield.response");

// 1. Escribir el evento de yield
fs.writeFileSync(yieldSignalPath, JSON.stringify(yieldEvent));

// 2. Esperar hasta que el padre escriba la respuesta
await new Promise<void>((resolve) => {
  const watcher = fs.watch(path.dirname(responsePath), (ev, file) => {
    if (file === "yield.response") {
      watcher.close();
      resolve();
    }
  });
});

// 3. Leer la respuesta del padre y devolvérsela al LLM
const response = fs.readFileSync(responsePath, "utf-8");
fs.unlinkSync(responsePath);
return { content: [{ type: "text", text: response }] };

// Padre (execution.ts al detectar yield event):
// 1. Lee yield.lock
// 2. Invoca onYield callback con { resume: (resp) => { writeFileSync(responsePath, resp) } }
// 3. Cuando el padre llama resume(), el subagente continúa
```

---

## 7. Impacto en tipos — Cambios en `types.ts`

```typescript
// === AÑADIR a types.ts ===

// Razones por las que un subagente puede hacer yield
export type YieldReason =
  | "task_complete"        // Terminó la tarea
  | "awaiting_input"       // Necesita input del usuario
  | "checkpoint"           // Punto de control (el padre puede inspeccionar)
  | "idle_timeout";        // Sin actividad por tiempo prolongado (heurístico)

// Evento emitido cuando el subagente hace yield
export interface YieldEvent {
  reason: YieldReason;
  prompt?: string;           // Mensaje del subagente para el padre/usuario
  partialOutput: string;     // Output generado hasta el momento del yield
  canResume: boolean;        // Si true, el padre puede enviar respuesta y continuar
  asyncId?: string;          // Si es ejecución async, el ID del run
  stepIndex?: number;        // Si es chain, el índice del paso actual
}

// Wrapper para una ejecución en estado de yield
export interface YieldedExecution {
  yieldEvent: YieldEvent;
  partialResult: Partial<SingleResult>;  // Result parcial hasta el momento
  resume: (response: string) => Promise<SingleResult>;  // Reanudar con respuesta
  abort: () => void;                     // Cancelar definitivamente
}

// === MODIFICAR RunSyncOptions ===
export interface RunSyncOptions {
  // ...todas las opciones existentes...
  /** Callback invocado cuando el subagente hace yield (pausa y espera) */
  onYield?: (yielded: YieldedExecution) => void | Promise<void>;
  /** Directorio para comunicación yield/resume via filesystem */
  yieldDir?: string;
  /** Tiempo de inactividad en ms antes de yield heurístico (0 = desactivado) */
  idleYieldMs?: number;
}

// === MODIFICAR SingleResult ===
export interface SingleResult {
  // ...todas las propiedades existentes...
  /** Si el resultado viene de una ejecución con yield, el evento de yield */
  yieldEvent?: YieldEvent;
  /** Si el subagente fue reanudado después de un yield */
  wasResumed?: boolean;
  /** Número de veces que el subagente hizo yield antes de completar */
  yieldCount?: number;
}

// === MODIFICAR SubagentState ===
export interface SubagentState {
  // ...todas las propiedades existentes...
  /** Ejecuciones actualmente en estado de yield, por asyncId o runId */
  yieldedExecutions: Map<string, YieldedExecution>;
}

// === NUEVO EVENTO para pi.events ===
// pi.events.emit("subagent:yield", { asyncId, yieldEvent })
// pi.events.emit("subagent:resumed", { asyncId, response })
```

### Impacto en `Details` (para renderizado)

```typescript
export interface Details {
  // ...propiedades existentes...
  /** Si hay un yield activo, el evento correspondiente */
  activeYield?: YieldEvent;
}
```

---

## 8. Riesgos y trade-offs

### 8.1 Race conditions

**Escenario:** El subagente hace yield exactamente cuando el padre ya está procesando el `proc.close`. El archivo `yield.lock` se escribe pero el padre ya resolvió el Promise.

**Mitigación:** Orden estricto de comprobación: siempre verificar `yield.lock` antes de procesar `close`. Si se recibe `close` mientras hay un yield pendiente, el yield gana (el proceso ya terminó su work y solo espera).

### 8.2 Falsos positivos en detección heurística de idle

Un modelo razonando durante 25 segundos parece idle. Si el threshold es 30s, no hay falso positivo. Si el threshold es 20s, se interrumpe prematuramente.

**Mitigación:** Solo usar detección heurística como safety net con threshold alto (≥60s). La detección explícita via herramienta `yield_to_parent` es la preferida. Hacer el threshold configurable.

### 8.3 Complejidad de estado en chains

En una chain con 5 pasos, si el paso 3 hace yield, el estado de la chain queda suspendido. El padre necesita recordar:
- Qué paso está pausado
- El output de los pasos anteriores
- El contexto de la chain

**Mitigación:** Serializar el estado de la chain en el `chainDir` antes del yield. Ya existe la abstracción de `chainDir` con `status.json`.

### 8.4 Yield en modo parallel

Si dos subagentes paralelos hacen yield simultáneamente, el padre recibiría dos `onYield` callbacks concurrentes. ¿Cuál responde primero?

**Mitigación:** Queue de yields. El padre procesa un yield a la vez. Los demás esperan en `yield.lock` hasta que el padre esté disponible.

### 8.5 Profundidad de anidamiento

Si un subagente a su vez lanza sub-subagentes (depth 2), un yield del sub-subagente burbujea hasta el subagente, ¿y de ahí al padre original?

**Mitigación:** Protocolo de yield solo funciona entre padre inmediato e hijo. Un yield en depth=2 es manejado por depth=1, que puede a su vez hacer su propio yield.

### 8.6 Compatibilidad con modo async

El modo async actual retorna inmediatamente con `asyncId`. Si se añade yield, ¿cómo devuelve el "control" si el padre ya continuó?

**Mitigación:** En modo async, yield significa notificación via `pi.events.emit("subagent:yield")`. El padre puede pausar su propia ejecución o simplemente notificar al usuario. No hay coroutine — es un evento que el padre puede ignorar o actuar sobre él.

### 8.7 Compatibilidad Windows

`SIGSTOP`/`SIGCONT` no existen en Windows. El mecanismo de filesystem (`yield.lock`) es portable.

---

## 9. Propuesta de implementación incremental

### Fase 1: Yield por completión en modo async (mínimo esfuerzo)

**Qué:** El async poller (`async-job-tracker.ts`) ya sabe cuándo un paso de la chain completa (`step.completed` en events.jsonl). Exponer esto como evento `subagent:yield` con `reason: "checkpoint"`.

**Cambios:**
- `async-job-tracker.ts`: leer `events.jsonl` en el poll interval, emitir `pi.events.emit("subagent:yield", ...)` por cada `subagent.step.completed`
- `types.ts`: añadir `YieldEvent` interface y `yieldedExecutions` en `SubagentState`
- `index.ts`: escuchar `subagent:yield` y opcionalmente notificar al usuario via `pi.notifications`

**Estimación:** 2-4 horas. **Riesgo:** Bajo.

### Fase 2: Herramienta `yield_to_parent` en modo headless

**Qué:** Registrar una herramienta que el subagente puede invocar, que escribe en `asyncDir/yield.lock`. El padre monitorea este archivo y, cuando aparece, invoca `onYield`.

**Cambios:**
- Nueva herramienta registrada via el `tools` del agente o inyectada en el system prompt como instrucción + herramienta dinámica
- `execution.ts`: `runSync` acepta nuevo `yieldDir` y `onYield` callback
- Monitoreo de `yieldDir/yield.lock` en el loop de procesado de stdout
- Mecanismo de respuesta: `yieldDir/yield.response`

**Estimación:** 1-2 días. **Riesgo:** Medio (coordinación de estado).

### Fase 3: Yield en modo tmux

**Qué:** Monitorear el session file del subagente tmux en tiempo real para detectar completión antes del cierre del pane.

**Cambios:**
- `tmux.ts`: nueva función `watchSessionFileForCompletion` usando `fs.watch`
- `execution.ts` (runSyncTmux): invocar watcher + callback `onYield`
- Preservar el pane abierto si `onYield` devuelve instrucción de continuar

**Estimación:** 1 día. **Riesgo:** Medio (race condition pane-cierre vs session-file).

### Fase 4: Coroutine completa con resume (ambicioso)

**Qué:** El padre puede enviar respuestas al subagente pausado. El subagente reanuda con la respuesta del padre/usuario.

**Cambios:**
- Protocolo completo de `yield.lock` / `yield.response` via filesystem
- `execution.ts`: pausa activa del proceso (filesystem-based, no SIGSTOP)
- `subagent-executor.ts`: nueva función `resumeYieldedExecution(runId, response)`
- Nuevo slash command `/resume <asyncId>` para que el usuario responda manualmente
- TUI: mostrar el prompt de yield en la UI para que el usuario pueda responder

**Estimación:** 3-5 días. **Riesgo:** Alto. Requiere testing exhaustivo de edge cases.

### Fase 5: Evento JSONL nativo (requiere cambio en pi core)

**Qué:** Añadir `yield_control` como tipo de evento nativo en el JSONL stream de pi.

**Cambios:**
- Modificar `@mariozechner/pi-coding-agent` para emitir `{"type":"yield_control",...}` cuando el agente llama una herramienta especial
- `execution.ts`: procesar este nuevo tipo de evento
- Eliminar el workaround del filesystem

**Estimación:** Depende del acceso al repo de pi. **Riesgo:** Medio (cambio en core).

---

## 10. Resumen ejecutivo y recomendación

### Viabilidad: Alta para Fases 1-2, Media para Fases 3-4

El sistema actual tiene una arquitectura sólida que puede extenderse para soportar yield control sin reescrituras masivas.

### Recomendación de implementación

**Empezar con Fase 1 (async step yield):** Tiene el mayor value/esfuerzo. Los chains async ya emiten eventos `subagent.step.completed` en `events.jsonl`. Solo hay que conectarlos al sistema de eventos del padre. Esto habilita el caso de uso más común: "el subagente terminó una fase, notificar al padre para que pueda decidir continuar".

**Fase 2 (herramienta yield_to_parent):** Habilitaría casos de uso poderosos como subagentes que preguntan al usuario en puntos de control, sin modificar pi core.

**Evitar la detección heurística de idle** como mecanismo primario — los falsos positivos y la dificultad de calibración la hacen poco confiable. Usar solo como fallback con threshold alto.

### Casos de uso que se habilitan

1. **Aprobación humana en cadena:** Scout termina análisis → yield → usuario aprueba → Planner ejecuta cambios
2. **Preguntas aclaratorias:** El worker subagente tiene una pregunta técnica → yield → el LLM padre responde con contexto adicional → el worker continúa
3. **Checkpointing:** En chains largas, el padre puede guardar estado intermedio y mostrar progreso al usuario antes de continuar
4. **Fail-fast con notificación:** Si el subagente detecta que necesita permisos que no tiene, hace yield en lugar de fallar

### Casos que siguen sin resolver sin cambios en pi core

- Yield durante la generación del LLM (mientras el modelo está "pensando")
- Yield en modo `-p` headless con stdin bidireccional nativo
- Introspección del estado interno del LLM en tiempo real

---

*Documento generado por análisis del codebase `pi-subagents` v1.x — archivos clave analizados: `execution.ts`, `subagent-runner.ts`, `async-execution.ts`, `result-watcher.ts`, `async-job-tracker.ts`, `tmux.ts`, `types.ts`, `chain-execution.ts`, `session-parser.ts`, `slash-bridge.ts`.*
