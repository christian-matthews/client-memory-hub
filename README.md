# Client Compass

Quiero construir y desplegar una aplicación web nueva desde cero, llamada provisionalmente “Client Memory”.

VISIÓN DEL PRODUCTO

Client Memory es un sistema AI-centric de memoria operativa por cliente. No es un CRM tradicional, un gestor de tickets ni una simple lista de tareas.

Debe responder rápidamente:

¿Dónde estamos con este cliente?

¿Qué cambió recientemente?

¿Qué temas siguen abiertos?

¿Qué debemos nosotros?

¿Qué debe el cliente?

¿Quién tiene la pelota?

¿Cuál es el próximo paso?

¿Qué está bloqueado, vencido o estancado?

¿Qué evidencia respalda cada conclusión?

El producto debe poder evolucionar hasta convertirse en un SaaS multiempresa y en una memoria externa que cualquier asistente de IA —Claude, ChatGPT, agentes propios u otros clientes compatibles— pueda consultar y operar mediante MCP.

No reutilices código, migraciones, tablas ni arquitectura de otros proyectos. Este producto empieza desde cero.

PRINCIPIO CENTRAL

La arquitectura debe ser AI-centric desde el inicio:

La interfaz web y los agentes de IA deben utilizar la misma capa de acciones del dominio.

La lógica principal no debe quedar encerrada en componentes React.

Toda información importante debe poder consultarse mediante datos estructurados.

Toda acción realizada por una IA debe ser trazable.

Las conclusiones automáticas deben conservar sus fuentes.

La IA debe proponer cambios sensibles antes de aplicarlos.

El sistema debe ser independiente de un proveedor específico de modelos.

La ausencia temporal de IA no debe impedir operar manualmente el sistema.

MCP debe ser una interfaz del producto, no una implementación paralela con lógica propia.

La jerarquía conceptual es:

Workspace
→ Cliente
→ Tema
→ Actualizaciones, decisiones y compromisos
→ Fuentes y evidencia

Los correos, reuniones, notas y documentos serán fuentes. Los temas serán la memoria viva. Los compromisos serán lo accionable. El cliente será la vista consolidada.

OBJETIVO DE LA PRIMERA VERSIÓN

Construye una versión funcional, segura, desplegable y preparada para SaaS.

Debe incluir:

autenticación;

workspaces con aislamiento multi-tenant;

clientes;

contactos;

temas;

actualizaciones;

decisiones;

compromisos;

fuentes manuales;

tablero de atención;

ficha consolidada del cliente;

historial de actividad;

capa de acciones reutilizable;

API interna estructurada;

un servidor MCP remoto inicial;

auditoría de acciones humanas y automáticas.

Todavía no integrar Gmail, Outlook, calendarios, Slack ni proveedores externos. Tampoco implementar extracción automática desde correos en esta primera versión. Sin embargo, el modelo debe permitir agregar posteriormente esas fuentes sin rediseñar el núcleo.

NO CONSTRUIR TODAVÍA

pipeline comercial;

leads, deals o cotizaciones;

facturación;

campañas;

kanban;

portal para clientes;

aplicación móvil nativa;

automatizaciones complejas;

envío de correos;

sincronización de buzones;

chatbot decorativo;

embeddings sin un caso de uso real;

agentes autónomos que modifiquen datos sin control.

ARQUITECTURA TÉCNICA

Usa:

React y TypeScript.

Supabase para PostgreSQL, autenticación y Row Level Security.

TanStack Query para estado de servidor.

Zod para validar entradas, respuestas y contratos.

Migraciones SQL versionadas.

Tipos TypeScript estrictos; evitar any.

Variables de entorno para secretos y configuración.

Componentes accesibles y responsive.

Una capa de servicios o acciones de dominio independiente de React.

Organiza el código por dominios:

auth;

workspaces;

clients;

contacts;

topics;

commitments;

updates;

sources;

attention;

activity;

ai;

mcp;

shared.

No hagas páginas gigantes ni realices operaciones directas contra Supabase desde cada componente. Los componentes deben llamar hooks o servicios tipados, y estos deben utilizar una capa consistente de acceso y acciones.

CAPA DE ACCIONES DEL DOMINIO

Define acciones explícitas y reutilizables, por ejemplo:

createClient

updateClient

archiveClient

addClientContact

createTopic

updateTopicState

setTopicNextStep

addTopicUpdate

recordDecision

createCommitment

completeCommitment

cancelCommitment

linkSourceToTopic

getClientBrief

getAttentionItems

getTopicTimeline

La interfaz web, futuras automatizaciones y MCP deben compartir estas reglas. No dupliques lógica de validación, autorización ni auditoría.

Cada acción debe:

validar la entrada;

verificar el workspace y los permisos;

aplicar las reglas del dominio;

ejecutar la operación de forma atómica cuando corresponda;

registrar un evento de auditoría;

devolver una respuesta estructurada;

evitar duplicación mediante una clave de idempotencia cuando la acción pueda repetirse desde integraciones.

MODELO DE DATOS

Todas las tablas de negocio deben tener aislamiento explícito por workspace, directamente o mediante relaciones verificables.

workspaces

id

name

slug

created_at

updated_at

workspace_members

workspace_id

user_id

role: owner, admin o member

created_at

updated_at

La arquitectura debe permitir agregar planes, límites y billing posteriormente, pero no implementar cobros todavía.

clients

id

workspace_id

name

description opcional

relationship_status: active, paused o archived

owner_user_id

health: good, attention, risk o unknown

current_summary opcional

last_relevant_activity_at opcional

created_at

updated_at

archived_at opcional

client_contacts

id

workspace_id

client_id

name

email opcional

role opcional

is_primary

created_at

updated_at

archived_at opcional

topics

id

workspace_id

client_id

title

description opcional

status: active, waiting_client, pending_us, blocked, monitoring, resolved o archived

priority: high, medium o low

owner_user_id

ball_with: us, client, third_party o nobody

current_state

next_step opcional

next_step_owner: us, client, third_party o nobody

next_step_due_at opcional

last_relevant_change_at opcional

created_at

updated_at

resolved_at opcional

archived_at opcional

commitments

id

workspace_id

client_id

topic_id

description

responsible_party: us, client o third_party

responsible_name opcional

status: open, completed, cancelled o overdue

due_at opcional

completed_at opcional

created_at

updated_at

archived_at opcional

topic_updates

id

workspace_id

client_id

topic_id

update_type: note, fact, decision, status_change o milestone

content

is_relevant

created_by opcional

created_at

sources

Esta tabla representa evidencia que en el futuro podrá provenir de correos, reuniones, documentos, APIs o notas.

id

workspace_id

client_id opcional

source_type: manual_note, email, meeting, document, api o other

external_provider opcional

external_id opcional

title opcional

content_text opcional

occurred_at opcional

metadata JSON

content_hash opcional

created_by opcional

created_at

Crear una restricción o índice que permita deduplicar fuentes externas mediante workspace, proveedor y external_id.

topic_sources

topic_id

source_id

relevance opcional

linked_by

created_at

decisions

id

workspace_id

client_id

topic_id

description

decided_at

status: active o superseded

source_id opcional

created_by opcional

created_at

activity_events

Debe ser una bitácora append-only.

id

workspace_id

client_id opcional

topic_id opcional

actor_type: user, ai, system o integration

actor_user_id opcional

actor_name opcional

event_type

entity_type

entity_id opcional

description

input_summary opcional

metadata JSON

correlation_id opcional

idempotency_key opcional

created_at

ai_runs

Preparar trazabilidad de futuras operaciones de IA.

id

workspace_id

initiated_by_user_id opcional

purpose

provider

model

prompt_version

status: pending, running, completed, failed o cancelled

input_source_ids

structured_output JSON opcional

confidence opcional

error_message opcional

created_at

completed_at opcional

ai_proposals

Permite que la IA proponga cambios antes de aplicarlos.

id

workspace_id

ai_run_id

client_id opcional

topic_id opcional

proposal_type

proposed_changes JSON

explanation

confidence

status: pending, approved, rejected, applied o expired

reviewed_by opcional

reviewed_at opcional

applied_at opcional

created_at

Usa claves foráneas, restricciones, índices y timestamps consistentes. Evita guardar información importante únicamente dentro de JSON. JSON se debe reservar para metadata variable y resultados estructurados extensibles.

MULTI-TENANCY Y SEGURIDAD

Diseña el producto como SaaS multi-tenant desde el comienzo:

Un usuario puede pertenecer a varios workspaces.

Cada registro debe pertenecer inequívocamente a un workspace.

Solo miembros autorizados pueden leer datos del workspace.

Los permisos deben verificarse en servidor y mediante RLS.

Cambiar un ID en el navegador nunca debe permitir acceder a otro workspace.

Las políticas deben cubrir SELECT, INSERT, UPDATE y archivado.

No usar políticas como authenticated USING true.

No confiar en un workspace_id enviado por el cliente sin verificar membresía.

No exponer service-role keys al frontend.

Mantener separación clara entre credenciales públicas y privadas.

Preparar una estrategia segura para cuentas de servicio e integraciones futuras.

Registrar en auditoría las operaciones relevantes.

Crear automáticamente un workspace inicial seguro al registrar un usuario, evitando condiciones de carrera o workspaces huérfanos.

AI-CENTRIC, PERO INDEPENDIENTE DEL MODELO

Crea una interfaz de proveedor de IA para que posteriormente puedan conectarse distintos proveedores sin modificar el dominio.

La interfaz conceptual debe aceptar:

purpose;

system instructions;

structured input;

source references;

expected schema;

model configuration;

workspace context.

Debe devolver:

structured output;

provider;

model;

prompt version;

confidence;

usage metadata si existe;

errors normalizados.

En esta primera versión no es necesario llamar a un modelo real para generar la memoria del cliente. Implementa la estructura, contratos, almacenamiento de ejecuciones y propuestas, pero mantén el flujo principal completamente funcional sin IA.

No simules resultados de IA como si fueran reales.

MEMORIA Y EVIDENCIA

Diseña toda futura función de IA bajo estas reglas:

Una síntesis no es una fuente.

Toda afirmación automática relevante debe referenciar una o más fuentes.

La IA no debe sobrescribir silenciosamente el estado humano.

Los cambios sensibles deben convertirse en ai_proposals.

El usuario debe poder aprobar o rechazar propuestas.

Registrar modelo, prompt, momento, fuentes, resultado y decisión humana.

Los resúmenes deben poder reconstruirse si cambia el modelo o el prompt.

Una fuente original no debe modificarse para reflejar una interpretación posterior.

MCP

Implementa un servidor MCP remoto inicial y documentado como una interfaz oficial del producto.

Debe:

vivir separado del frontend;

usar la misma capa de acciones del dominio;

autenticar cada solicitud;

resolver el usuario o cuenta de servicio y el workspace autorizado;

aplicar los mismos permisos que la aplicación web;

validar inputs y outputs con esquemas;

registrar cada llamada en activity_events;

no incluir secretos en respuestas o logs;

incluir manejo de errores estructurado;

estar preparado para múltiples clientes MCP;

documentar cómo conectarlo desde un cliente compatible.

No diseñes MCP como acceso SQL genérico. Expón herramientas seguras orientadas al dominio.

Herramientas MCP iniciales de lectura:

list_clients

get_client_brief

list_client_topics

get_topic

get_topic_timeline

list_open_commitments

get_attention_items

search_client_memory

Herramientas MCP iniciales de escritura:

create_client

create_topic

add_topic_update

set_topic_next_step

create_commitment

complete_commitment

Reglas para herramientas de escritura:

Requerir confirmación explícita del cliente MCP o usar un flujo de propuesta para acciones sensibles.

Incluir un argumento opcional idempotency_key.

Devolver la entidad modificada y un resumen del efecto.

Rechazar operaciones fuera del workspace autorizado.

No permitir eliminación permanente.

Registrar actor, herramienta, argumentos resumidos, resultado y correlation ID.

Diseñar scopes separados de lectura y escritura.

Poder desactivar completamente las herramientas de escritura por integración.

Para acciones que modifiquen varias entidades o impliquen inferencias, crear primero una propuesta y aplicar únicamente después de su aprobación.

AUTENTICACIÓN DE INTEGRACIONES

Diseña una base segura y extensible para MCP:

usuarios humanos autenticados;

futuras cuentas de servicio;

integraciones vinculadas a un workspace;

scopes de mínimo privilegio;

revocación de credenciales;

expiración;

último uso;

auditoría.

Si la plataforma actual no permite implementar correctamente un flujo OAuth completo, no inventes uno inseguro. Implementa la separación de componentes, contratos, tablas y middleware necesarios; documenta con precisión lo que queda pendiente para una implementación compatible y segura.

No uses una API key global compartida entre todos los workspaces.

API Y PORTABILIDAD

MCP no debe ser la única interfaz programática. Mantén las acciones de dominio desacopladas para que después puedan exponerse también mediante una API HTTP autenticada.

La arquitectura debe permitir:

exportar los datos de un workspace;

importar fuentes;

ejecutar trabajos asíncronos;

conectar webhooks;

agregar nuevos conectores;

cambiar proveedor de IA;

implementar límites por plan;

medir consumo por workspace.

No es necesario construir todas estas funciones ahora, pero evita decisiones que las bloqueen.

PANTALLAS

Autenticación

Registro.

Inicio de sesión.

Cierre de sesión.

Selección de workspace cuando el usuario tenga más de uno.

Dashboard “Clientes”

Debe ser la pantalla principal.

Mostrar por cliente:

nombre;

resumen actual;

salud;

último movimiento relevante;

temas abiertos;

compromisos nuestros pendientes;

compromisos del cliente pendientes;

próximo paso más cercano;

días sin movimiento relevante;

motivo concreto de atención.

Filtros:

todos;

requieren atención;

esperando al cliente;

pendientes nuestros;

sin movimiento reciente.

Ordenar primero lo que requiere atención.

Ficha del cliente

Mostrar:

nombre;

salud;

responsable;

resumen actual;

última actividad relevante;

temas abiertos;

compromisos nuestros;

compromisos del cliente;

contactos;

decisiones recientes;

fuentes recientes;

actividad;

temas resueltos o archivados.

Debe poder crearse un tema sin abandonar la ficha.

Detalle del tema

Mostrar claramente:

estado;

estado actual en texto;

quién tiene la pelota;

próximo paso;

fecha;

responsable;

compromisos;

decisiones;

cronología;

fuentes vinculadas;

propuestas de IA pendientes, aunque inicialmente no existan ejecuciones automáticas.

Al agregar una actualización, permitir opcionalmente:

cambiar estado;

cambiar quién tiene la pelota;

cambiar próximo paso;

crear un compromiso;

registrar una decisión.

La operación debe ser consistente y quedar auditada.

Configuración del workspace

Mostrar:

miembros;

roles;

integraciones futuras;

credenciales o conexiones MCP;

scopes;

último uso;

revocación.

Si la conexión MCP completa no puede implementarse en esta primera iteración, mostrar únicamente funcionalidades reales. No crear botones falsos.

REGLAS DE ATENCIÓN

Implementa reglas determinísticas, sin IA.

Un cliente requiere atención si:

existe un tema pending_us;

existe un tema blocked;

hay un compromiso nuestro vencido;

hay un próximo paso nuestro vencido;

un tema activo no tiene próximo paso;

un tema abierto no tiene actividad relevante durante siete días.

Mostrar siempre el motivo concreto. No mostrar solamente un color o semáforo.

RESUMEN DEL CLIENTE

En esta primera versión:

current_summary se edita manualmente;

no usar IA para generarlo;

mostrar además un resumen estructurado automático con:

temas abiertos;

último cambio relevante;

próximo paso;

compromisos nuestros;

compromisos del cliente;

bloqueos.

EXPERIENCIA VISUAL

Quiero una interfaz ejecutiva, sobria, clara y de alta densidad útil.

Interfaz en español.

Código y base de datos pueden usar inglés.

Evitar apariencia genérica de CRM.

Evitar exceso de tarjetas, gradientes y gráficos decorativos.

Usar color principalmente para salud, urgencia y responsabilidad.

Priorizar comprensión en menos de diez segundos.

Diseñar primero para escritorio con buena adaptación móvil.

Incluir estados vacíos, carga, error y confirmaciones.

Mostrar fechas según la zona horaria del usuario.

Mantener accesibilidad de teclado y contraste.

CALIDAD

Antes de entregar:

Ejecutar build de producción.

Ejecutar lint sin errores.

Usar tipos estrictos.

Validar entradas con Zod.

Agregar pruebas para las reglas de atención.

Agregar pruebas de aislamiento entre workspaces.

Agregar una prueba del flujo principal:

crear cliente;

crear tema;

agregar actualización;

crear y completar compromiso.

Agregar pruebas de autorización para MCP.

Verificar que una credencial de un workspace no acceda a otro.

Verificar idempotencia de al menos una herramienta MCP de escritura.

Verificar visualmente dashboard, cliente y tema.

No presentar mocks como funcionalidad completa.

No insertar datos de demostración en producción sin una acción explícita.

Documentar decisiones arquitectónicas importantes.

README Y DOCUMENTACIÓN

Incluye:

visión del producto;

arquitectura;

modelo de datos;

estructura del repositorio;

variables de entorno;

instalación;

migraciones;

pruebas;

despliegue;

seguridad y RLS;

arquitectura AI-centric;

ciclo de vida de ai_runs y ai_proposals;

herramientas MCP disponibles;

autenticación MCP;

scopes;

ejemplo de configuración para un cliente MCP compatible;

limitaciones actuales;

funcionalidades futuras claramente separadas de las implementadas.

DESPLIEGUE

Configura y despliega una versión funcional.

Antes de desplegar:

confirmar que se usa un proyecto Supabase nuevo;

ejecutar migraciones;

comprobar que no existan secretos en frontend o repositorio;

comprobar autenticación;

comprobar aislamiento multi-tenant;

comprobar el flujo completo cliente → tema → actualización → compromiso;

comprobar las herramientas MCP que realmente hayan sido implementadas;

comprobar auditoría de llamadas MCP;

ejecutar build, lint y pruebas.

Entrega:

URL de la aplicación;

URL o endpoint MCP, si está realmente operativo;

instrucciones de conexión;

scopes disponibles;

variables o configuraciones manuales pendientes;

lista exacta de funciones implementadas;

lista exacta de elementos diseñados pero aún no implementados.

FORMA DE TRABAJO

Primero presenta brevemente:

arquitectura propuesta;

modelo de datos definitivo;

límites entre frontend, dominio, datos, IA y MCP;

estrategia de autenticación y multi-tenancy;

estructura de navegación;

etapas de implementación.

Después implementa sin esperar confirmación, salvo que falten credenciales o haya una decisión que cambie materialmente el producto.

No amplíes el alcance con funcionalidades no solicitadas.

El objetivo es construir un núcleo pequeño, coherente y seguro que funcione hoy manualmente, pero que desde su arquitectura pueda convertirse en:

un SaaS multiempresa;

una memoria operativa alimentada por IA;

una fuente contextual para asistentes externos;

una colección segura de herramientas MCP;

una plataforma extensible mediante conectores y agentes.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/aa895b06-1eba-492a-95f8-922f696f5d8e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
