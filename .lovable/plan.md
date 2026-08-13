# Capa de "Temas vivos"

Buena noticia: el modelo actual ya tiene la jerarquía que pides (Cliente → Tema → actualizaciones/decisiones/compromisos → fuentes) y las reuniones ya alimentan temas vía propuestas de IA. Esta iteración no crea un modelo nuevo: completa lo que falta y reorganiza la interfaz para que un tema se entienda en menos de 10 segundos.

## Qué falta hoy (y se agrega)

1. **Campos del tema**: responsable interno y responsable del lado cliente (texto), y estado "En pausa".
2. **Trazabilidad de cada actualización**: hoy una actualización no guarda de qué reunión/nota vino. Se agrega ese vínculo para poder mostrar "12 ago — Reunión semanal → qué cambió".
3. **Salud del tema** (verde avanzando / amarillo sin cambios / rojo bloqueado o atrasado / azul esperando a un tercero), calculada con estado + pendientes + último movimiento material, no solo con fechas.
4. **Movimiento material**: ya existe la marca `is_relevant` en cada actualización; se usa para mostrar "último movimiento material" con su explicación y para descartar "gracias/recibido" (la IA ya marca esos como no relevantes, y en el formulario manual queda un check).

## Pantalla de tema (rediseño de la vista actual)

Cabecera ejecutiva compacta con: salud, estado, prioridad, responsables, resumen del estado actual, próximo paso con dueño y fecha, y último movimiento material con su explicación.

Debajo, cuatro bloques cortos lado a lado: **Pendientes míos**, **Pendientes cliente/terceros**, **Decisiones tomadas** (cronológicas) y **Bloqueos / riesgos**.

Pestañas: **Historia** (fecha → fuente → qué cambió, incluyendo cambios de estado y decisiones en una sola línea de tiempo), **Evidencia** (reuniones y notas vinculadas) y **Registrar actualización** (el formulario actual, con selector de fuente).

## Ficha de cliente

Se agrega arriba, antes de las pestañas, un bloque prominente **Temas activos** con tarjetas compactas: título, salud, estado, último avance, pendiente principal, próximo paso y "hace X días". Se entiende sin abrir la tarjeta.

## Vista global / Radar (`/topics`, nueva entrada en el menú)

Filtros: cliente, estado, prioridad, responsable, antigüedad. Agrupación en bloques: **Necesitan acción mía**, **Esperando cliente**, **Bloqueados**, **Sin movimiento reciente**, **Con mucha actividad**. Misma tarjeta compacta que en la ficha de cliente.

## Reuniones → temas

En la bandeja de reuniones, cada reunión ya procesada muestra **Temas discutidos**: la lista de temas que esa transcripción tocó (vía actualizaciones y evidencia vinculada), con enlace directo al tema. Se refuerza la regla de actualización incremental que ya existe: la IA propone actualizar un tema existente y solo crea tema nuevo si no hay coincidencia; nunca se borra historial.

## Arquitectura para IA

El contrato de extracción ya devuelve actualizaciones, decisiones, compromisos nuevos, próximos pasos y bloqueos por tema, con `existing_topic`. Se agregan dos cosas al contrato existente: cierre de compromisos (`closed_commitments`) y bloqueos como propuesta explícita, ambos revisables antes de aplicarse.

## Detalle técnico

- Migración: `topics.owner_name` y `topics.client_owner_name`; valor `paused` en el enum `topic_status`; `topic_updates.source_id` (referencia a `sources`, compuesta por workspace) más `blockers text` en `topics`.
- Dominio: `topicHealth()` y `materialMovement()` en `src/domain/attention/rules.ts`; `listWorkspaceTopics()` (radar) y ampliación de `getTopicTimeline` con historia unificada en `src/domain/queries/read.ts`; nuevas lecturas expuestas en `src/lib/read.functions.ts`.
- UI: nuevo `src/components/topic-card.tsx` reutilizado en ficha de cliente y radar; nueva ruta `src/routes/_authenticated/topics.index.tsx`; rediseño de `topics.$topicId.tsx`; bloque nuevo en `clients.$clientId.tsx`; badge de salud en `memory-bits.tsx`.
- Se mantienen los tokens y componentes visuales actuales; sin nuevas dependencias. Se extienden las pruebas de `rules.test.ts` con los casos de salud y movimiento material.
