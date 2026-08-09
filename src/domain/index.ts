/**
 * Domain barrel. The web app, MCP server and any future HTTP API import from
 * here — never from Supabase directly.
 */
export * from "./shared/errors";
export * from "./shared/context";
export * from "./shared/audit";
export * from "./shared/vocabulary";
export * from "./attention/rules";
export * from "./clients/actions";
export * from "./topics/actions";
export * from "./commitments/actions";
export * from "./sources/actions";
export * from "./queries/read";
export * from "./ai/provider";
export * from "./ingestion/actions";
export * from "./ai/meeting-processor";
