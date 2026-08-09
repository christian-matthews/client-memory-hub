# Client Memory

Memoria operativa por cliente. No es un CRM: el objetivo no es registrar
oportunidades ni contactos, sino responder en segundos **“¿cómo vamos con este
cliente y qué falta?”**, con las mismas reglas y la misma auditoría para
personas y para agentes de IA.

## Jerarquía conceptual

```text
Workspace
└── Cliente
    └── Tema (unidad de trabajo con estado, pelota y próximo paso)
        ├── Actualizaciones (append-only)
        ├── Decisiones
        └── Compromisos (nuestros / del cliente / de terceros)
Fuentes y evidencia  ──vinculadas a─→  Clientes y Temas
```

Un **tema** es la unidad central: siempre tiene estado, de quién es la pelota,
estado actual en texto y (idealmente) próximo paso con responsable y
vencimiento.

## Arquitectura

```text
src/domain/**            capa de dominio: acciones y consultas puras, sin framework
src/lib/*.functions.ts   server functions de TanStack Start (interfaz web)
src/mcp/**               servidor MCP (transporte JSON-RPC + catálogo de tools)
src/routes/**            UI y endpoint /api/public/mcp
```

Regla dura: **la web y MCP nunca hablan con la base de datos directamente**.
Ambos construyen un `DomainContext` y llaman a la misma acción de dominio. No
existe una acción disponible por MCP que no exista para la web, ni al revés.

### `DomainContext`

Todo el acceso pasa por un contexto que ya resolvió el límite multi-tenant:

| Campo | Significado |
| --- | --- |
| `db` | cliente de base de datos |
| `workspaceId` | espacio de trabajo verificado (nunca un argumento del llamante) |
| `role` | `owner` / `admin` / `member` |
| `actor` | `user`, `ai`, `system` o `integration` (queda en la auditoría) |
| `writeEnabled` | `false` para integraciones de solo lectura |
| `correlationId` | agrupa todos los eventos de una misma operación |

- Web: `createDomainContext` (`src/lib/domain-context.ts`) valida el bearer del
  usuario y su pertenencia al workspace.
- MCP: `createIntegrationContext` deriva el workspace **del token de la
  integración**. Un agente no puede pedir otro workspace: el argumento no
  existe.

## Modelo de seguridad

1. **RLS en todas las tablas**, siempre por `workspace_id`, evaluada con
   funciones `security definer` (`is_workspace_member`, `is_workspace_admin`,
   `workspace_role_of`) para evitar recursión de políticas.
2. **Integridad multi-tenant en el esquema**: claves únicas compuestas
   `(workspace_id, id)` y claves foráneas compuestas, de modo que una entidad
   hija no puede apuntar a un padre de otro workspace ni siquiera con un bug de
   aplicación.
3. **`activity_events` es append-only**: sin `UPDATE` ni `DELETE` por política.
4. **Reglas de membresía por trigger**: no se puede quedar sin `owner`, y solo
   `owner`/`admin` gestionan roles.
5. **Tokens MCP hasheados**: la base guarda SHA-256 más un prefijo público. El
   token en claro existe una única vez, en la respuesta de creación, y nunca se
   registra en logs ni en la auditoría.
6. **Errores internos no se filtran** al agente: se registran en el servidor y
   el llamante recibe un mensaje genérico.

## Operaciones atómicas e idempotencia

- La operación compuesta “agregar actualización a un tema” (actualización +
  cambio de estado/pelota/próximo paso + decisión + compromiso + vínculo de
  fuente + auditoría) se ejecuta **en una sola transacción de PostgreSQL** vía
  la función `add_topic_update_tx`. No hay estados intermedios visibles.
- Toda acción de escritura acepta `idempotencyKey`. La deduplicación vive en la
  tabla `idempotency_keys` (independiente de la auditoría) y compara un hash
  estable del payload:
  - misma clave + mismo payload → se devuelve el resultado original con
    `replayed: true`;
  - misma clave + payload distinto → error `conflict`;
  - clave en curso → error `conflict`.

## Reglas de atención (sin IA)

`src/domain/attention/rules.ts` es determinista y puro. El tablero nunca
muestra “rojo” sin razón: cada cliente marcado trae razones concretas.

| Código | Severidad | Dispara cuando |
| --- | --- | --- |
| `topic_blocked` | alta | el tema está bloqueado |
| `our_commitment_overdue` | alta | compromiso **nuestro** abierto y vencido |
| `our_next_step_overdue` | alta | próximo paso nuestro vencido |
| `topic_pending_us` | media | el tema está pendiente de nosotros |
| `topic_without_next_step` | media | tema abierto sin próximo paso |
| `topic_stale` | media | sin movimiento relevante hace ≥ 7 días |

Los temas cerrados (`resolved`, `archived`) nunca generan atención.

## Rol de la IA

La IA **nunca escribe directamente** en el estado del cliente:

1. `ai_runs` registra la corrida: propósito, proveedor, modelo, versión de
   prompt, fuentes usadas (`ai_run_sources`) y salida estructurada.
2. `ai_proposals` guarda cambios propuestos con explicación y confianza.
3. Una persona con rol `owner`/`admin` aprueba o rechaza; solo al aplicarse se
   escribe en el dominio, con auditoría del revisor.

Toda salida de IA es estructurada y trazable a sus fuentes.

## Servidor MCP

Endpoint: `POST /api/public/mcp` — JSON-RPC 2.0 sobre HTTP (Streamable HTTP).

Autenticación: `Authorization: Bearer <token de integración>`. El token se
genera en **Espacio de trabajo → Integraciones de agentes (MCP)** y define
workspace, scopes (`read` / `write`) y expiración.

```bash
curl -s https://<tu-dominio>/api/public/mcp \
  -H 'authorization: Bearer cm_xxxxxxxx_...' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Tools

| Tool | Scope |
| --- | --- |
| `list_clients`, `get_client_brief`, `list_client_topics` | read |
| `get_topic_timeline`, `list_open_commitments`, `get_attention_items` | read |
| `search_client_memory` | read |
| `create_client`, `create_topic` | write |
| `add_topic_update`, `set_topic_next_step` | write |
| `create_commitment`, `complete_commitment` | write |

Propiedades del servidor:

- **No hay tool de SQL ni acceso genérico a la base**; cada tool es una acción
  de dominio con esquema Zod validado.
- Una integración de solo lectura **no ve** las tools de escritura en
  `tools/list` y las rechaza en `tools/call`.
- Toda llamada queda auditada en `activity_events` con `actor_type =
  'integration'`, la tool usada y el resultado — nunca el token ni el payload
  completo.
- Las tools de escritura aceptan `idempotencyKey`, así un agente que reintenta
  no duplica compromisos ni actualizaciones.

Nota técnica: el transporte se implementa a mano en `src/mcp/handler.ts` en
lugar de usar `@lovable.dev/mcp-js` porque ese paquete solo admite OAuth 2.1
con sesiones de usuario final, y aquí hacen falta credenciales de integración
de larga duración con scope por workspace.

## Pruebas

```bash
bun run test           # suite completa
bun run test:coverage  # cobertura de src/domain y src/mcp
```

Cubierto hoy:

- `src/domain/attention/rules.test.ts` — cada regla, sus límites (umbral de
  estancamiento exacto, temas cerrados, compromisos ajenos) y el orden por
  severidad.
- `src/domain/shared/idempotency.test.ts` — hash estable independiente del
  orden de claves.
- `src/mcp/handler.test.ts` — handshake, los cuatro modos de fallo de
  autenticación, enforcement de scopes, workspace derivado del token (no del
  argumento del agente), validación de argumentos y no filtración de errores
  internos.

## Limitaciones conocidas

- No hay pruebas de integración que ejecuten RLS real contra la base; la
  cobertura actual es de dominio y transporte.
- `search_client_memory` usa búsqueda por texto simple (`ILIKE`), sin ranking
  ni embeddings.
- La aplicación de propuestas de IA cubre los tipos de cambio ya modelados; no
  hay motor genérico de parches.
- Un usuario pertenece a workspaces sin flujo de invitación por correo todavía.
