export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor_name: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          actor_user_id: string | null
          client_id: string | null
          correlation_id: string | null
          created_at: string
          description: string
          entity_id: string | null
          entity_type: string
          event_type: string
          id: string
          idempotency_key: string | null
          input_summary: string | null
          metadata: Json
          topic_id: string | null
          workspace_id: string
        }
        Insert: {
          actor_name?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          actor_user_id?: string | null
          client_id?: string | null
          correlation_id?: string | null
          created_at?: string
          description: string
          entity_id?: string | null
          entity_type: string
          event_type: string
          id?: string
          idempotency_key?: string | null
          input_summary?: string | null
          metadata?: Json
          topic_id?: string | null
          workspace_id: string
        }
        Update: {
          actor_name?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          actor_user_id?: string | null
          client_id?: string | null
          correlation_id?: string | null
          created_at?: string
          description?: string
          entity_id?: string | null
          entity_type?: string
          event_type?: string
          id?: string
          idempotency_key?: string | null
          input_summary?: string | null
          metadata?: Json
          topic_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_events_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "activity_events_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      ai_proposals: {
        Row: {
          ai_run_id: string
          applied_at: string | null
          client_id: string | null
          confidence: number | null
          created_at: string
          explanation: string
          id: string
          proposal_type: string
          proposed_changes: Json
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["ai_proposal_status"]
          topic_id: string | null
          workspace_id: string
        }
        Insert: {
          ai_run_id: string
          applied_at?: string | null
          client_id?: string | null
          confidence?: number | null
          created_at?: string
          explanation: string
          id?: string
          proposal_type: string
          proposed_changes?: Json
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["ai_proposal_status"]
          topic_id?: string | null
          workspace_id: string
        }
        Update: {
          ai_run_id?: string
          applied_at?: string | null
          client_id?: string | null
          confidence?: number | null
          created_at?: string
          explanation?: string
          id?: string
          proposal_type?: string
          proposed_changes?: Json
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["ai_proposal_status"]
          topic_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_proposals_ai_run_id_fkey"
            columns: ["ai_run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_proposals_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "ai_proposals_ws_run_fkey"
            columns: ["workspace_id", "ai_run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "ai_proposals_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      ai_run_sources: {
        Row: {
          ai_run_id: string
          created_at: string
          source_id: string
          workspace_id: string
        }
        Insert: {
          ai_run_id: string
          created_at?: string
          source_id: string
          workspace_id: string
        }
        Update: {
          ai_run_id?: string
          created_at?: string
          source_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_run_sources_ws_run_fkey"
            columns: ["workspace_id", "ai_run_id"]
            isOneToOne: false
            referencedRelation: "ai_runs"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "ai_run_sources_ws_source_fkey"
            columns: ["workspace_id", "source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      ai_runs: {
        Row: {
          completed_at: string | null
          confidence: number | null
          created_at: string
          error_message: string | null
          id: string
          initiated_by_user_id: string | null
          input_source_ids: string[]
          model: string
          prompt_version: string
          provider: string
          purpose: string
          status: Database["public"]["Enums"]["ai_run_status"]
          structured_output: Json | null
          workspace_id: string
        }
        Insert: {
          completed_at?: string | null
          confidence?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by_user_id?: string | null
          input_source_ids?: string[]
          model: string
          prompt_version: string
          provider: string
          purpose: string
          status?: Database["public"]["Enums"]["ai_run_status"]
          structured_output?: Json | null
          workspace_id: string
        }
        Update: {
          completed_at?: string | null
          confidence?: number | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by_user_id?: string | null
          input_source_ids?: string[]
          model?: string
          prompt_version?: string
          provider?: string
          purpose?: string
          status?: Database["public"]["Enums"]["ai_run_status"]
          structured_output?: Json | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      client_contacts: {
        Row: {
          archived_at: string | null
          client_id: string
          created_at: string
          email: string | null
          id: string
          is_primary: boolean
          name: string
          role: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          client_id: string
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          role?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          client_id?: string
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          role?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_contacts_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      clients: {
        Row: {
          archived_at: string | null
          created_at: string
          current_summary: string | null
          description: string | null
          health: Database["public"]["Enums"]["client_health"]
          id: string
          last_relevant_activity_at: string | null
          name: string
          owner_user_id: string | null
          relationship_status: Database["public"]["Enums"]["relationship_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          current_summary?: string | null
          description?: string | null
          health?: Database["public"]["Enums"]["client_health"]
          id?: string
          last_relevant_activity_at?: string | null
          name: string
          owner_user_id?: string | null
          relationship_status?: Database["public"]["Enums"]["relationship_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          current_summary?: string | null
          description?: string | null
          health?: Database["public"]["Enums"]["client_health"]
          id?: string
          last_relevant_activity_at?: string | null
          name?: string
          owner_user_id?: string | null
          relationship_status?: Database["public"]["Enums"]["relationship_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      commitments: {
        Row: {
          archived_at: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          description: string
          due_at: string | null
          id: string
          responsible_name: string | null
          responsible_party: Database["public"]["Enums"]["responsible_party"]
          status: Database["public"]["Enums"]["commitment_status"]
          topic_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          description: string
          due_at?: string | null
          id?: string
          responsible_name?: string | null
          responsible_party: Database["public"]["Enums"]["responsible_party"]
          status?: Database["public"]["Enums"]["commitment_status"]
          topic_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          description?: string
          due_at?: string | null
          id?: string
          responsible_name?: string | null
          responsible_party?: Database["public"]["Enums"]["responsible_party"]
          status?: Database["public"]["Enums"]["commitment_status"]
          topic_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commitments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitments_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "commitments_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      decisions: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          decided_at: string
          description: string
          id: string
          source_id: string | null
          status: Database["public"]["Enums"]["decision_status"]
          topic_id: string
          workspace_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          decided_at?: string
          description: string
          id?: string
          source_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
          topic_id: string
          workspace_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          decided_at?: string
          description?: string
          id?: string
          source_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
          topic_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "decisions_ws_source_fkey"
            columns: ["workspace_id", "source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "decisions_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          actor_type: Database["public"]["Enums"]["actor_type"]
          completed_at: string | null
          created_at: string
          error_message: string | null
          expires_at: string
          key: string
          operation: string
          request_hash: string
          result: Json | null
          status: Database["public"]["Enums"]["idempotency_status"]
          workspace_id: string
        }
        Insert: {
          actor_type?: Database["public"]["Enums"]["actor_type"]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string
          key: string
          operation: string
          request_hash: string
          result?: Json | null
          status?: Database["public"]["Enums"]["idempotency_status"]
          workspace_id: string
        }
        Update: {
          actor_type?: Database["public"]["Enums"]["actor_type"]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          expires_at?: string
          key?: string
          operation?: string
          request_hash?: string
          result?: Json | null
          status?: Database["public"]["Enums"]["idempotency_status"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "idempotency_keys_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      mcp_integrations: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          token_hash: string | null
          token_prefix: string | null
          updated_at: string
          workspace_id: string
          write_enabled: boolean
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string | null
          token_prefix?: string | null
          updated_at?: string
          workspace_id: string
          write_enabled?: boolean
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string | null
          token_prefix?: string | null
          updated_at?: string
          workspace_id?: string
          write_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "mcp_integrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sources: {
        Row: {
          client_id: string | null
          content_hash: string | null
          content_text: string | null
          created_at: string
          created_by: string | null
          external_id: string | null
          external_provider: string | null
          id: string
          metadata: Json
          occurred_at: string | null
          source_type: Database["public"]["Enums"]["source_type"]
          title: string | null
          workspace_id: string
        }
        Insert: {
          client_id?: string | null
          content_hash?: string | null
          content_text?: string | null
          created_at?: string
          created_by?: string | null
          external_id?: string | null
          external_provider?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string | null
          source_type?: Database["public"]["Enums"]["source_type"]
          title?: string | null
          workspace_id: string
        }
        Update: {
          client_id?: string | null
          content_hash?: string | null
          content_text?: string | null
          created_at?: string
          created_by?: string | null
          external_id?: string | null
          external_provider?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string | null
          source_type?: Database["public"]["Enums"]["source_type"]
          title?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sources_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sources_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      topic_sources: {
        Row: {
          created_at: string
          linked_by: string | null
          relevance: string | null
          source_id: string
          topic_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          linked_by?: string | null
          relevance?: string | null
          source_id: string
          topic_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          linked_by?: string | null
          relevance?: string | null
          source_id?: string
          topic_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topic_sources_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_sources_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_sources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_sources_ws_source_fkey"
            columns: ["workspace_id", "source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "topic_sources_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      topic_updates: {
        Row: {
          client_id: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_relevant: boolean
          topic_id: string
          update_type: Database["public"]["Enums"]["update_type"]
          workspace_id: string
        }
        Insert: {
          client_id: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_relevant?: boolean
          topic_id: string
          update_type?: Database["public"]["Enums"]["update_type"]
          workspace_id: string
        }
        Update: {
          client_id?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_relevant?: boolean
          topic_id?: string
          update_type?: Database["public"]["Enums"]["update_type"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topic_updates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_updates_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_updates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topic_updates_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "topic_updates_ws_topic_fkey"
            columns: ["workspace_id", "topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      topics: {
        Row: {
          archived_at: string | null
          ball_with: Database["public"]["Enums"]["party"]
          client_id: string
          created_at: string
          current_state: string
          description: string | null
          id: string
          last_relevant_change_at: string | null
          next_step: string | null
          next_step_due_at: string | null
          next_step_owner: Database["public"]["Enums"]["party"]
          owner_user_id: string | null
          priority: Database["public"]["Enums"]["priority_level"]
          resolved_at: string | null
          status: Database["public"]["Enums"]["topic_status"]
          title: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          archived_at?: string | null
          ball_with?: Database["public"]["Enums"]["party"]
          client_id: string
          created_at?: string
          current_state?: string
          description?: string | null
          id?: string
          last_relevant_change_at?: string | null
          next_step?: string | null
          next_step_due_at?: string | null
          next_step_owner?: Database["public"]["Enums"]["party"]
          owner_user_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["topic_status"]
          title: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          archived_at?: string | null
          ball_with?: Database["public"]["Enums"]["party"]
          client_id?: string
          created_at?: string
          current_state?: string
          description?: string | null
          id?: string
          last_relevant_change_at?: string | null
          next_step?: string | null
          next_step_due_at?: string | null
          next_step_owner?: Database["public"]["Enums"]["party"]
          owner_user_id?: string | null
          priority?: Database["public"]["Enums"]["priority_level"]
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["topic_status"]
          title?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "topics_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "topics_ws_client_fkey"
            columns: ["workspace_id", "client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["workspace_id", "id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          role: Database["public"]["Enums"]["workspace_role"]
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: Database["public"]["Enums"]["workspace_role"]
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_topic_update_tx: {
        Args: {
          p_actor_channel?: string
          p_actor_name?: string
          p_actor_type?: Database["public"]["Enums"]["actor_type"]
          p_actor_user_id?: string
          p_ball_with?: Database["public"]["Enums"]["party"]
          p_commitment?: Json
          p_content: string
          p_correlation_id?: string
          p_current_state?: string
          p_decision?: string
          p_idempotency_key?: string
          p_is_relevant?: boolean
          p_next_step?: string
          p_next_step_due_at?: string
          p_next_step_owner?: Database["public"]["Enums"]["party"]
          p_next_step_set?: boolean
          p_request_hash?: string
          p_source_id?: string
          p_status?: Database["public"]["Enums"]["topic_status"]
          p_topic_id: string
          p_update_type?: Database["public"]["Enums"]["update_type"]
          p_workspace_id: string
        }
        Returns: Json
      }
      assert_workspace_access: {
        Args: { _workspace_id: string }
        Returns: undefined
      }
      create_workspace_with_owner: {
        Args: { p_name: string; p_slug?: string }
        Returns: string
      }
      ensure_default_workspace: { Args: never; Returns: string }
      idempotency_finish: {
        Args: {
          p_error?: string
          p_key: string
          p_ok: boolean
          p_result?: Json
          p_workspace_id: string
        }
        Returns: undefined
      }
      idempotency_reserve: {
        Args: {
          p_actor_type?: Database["public"]["Enums"]["actor_type"]
          p_key: string
          p_operation: string
          p_request_hash: string
          p_workspace_id: string
        }
        Returns: Json
      }
      is_workspace_admin: { Args: { _workspace_id: string }; Returns: boolean }
      is_workspace_member: { Args: { _workspace_id: string }; Returns: boolean }
      workspace_role_of: {
        Args: { _workspace_id: string }
        Returns: Database["public"]["Enums"]["workspace_role"]
      }
    }
    Enums: {
      actor_type: "user" | "ai" | "system" | "integration"
      ai_proposal_status:
        | "pending"
        | "approved"
        | "rejected"
        | "applied"
        | "expired"
      ai_run_status:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "cancelled"
      client_health: "good" | "attention" | "risk" | "unknown"
      commitment_status: "open" | "completed" | "cancelled" | "overdue"
      decision_status: "active" | "superseded"
      idempotency_status: "in_progress" | "completed" | "failed"
      party: "us" | "client" | "third_party" | "nobody"
      priority_level: "high" | "medium" | "low"
      relationship_status: "active" | "paused" | "archived"
      responsible_party: "us" | "client" | "third_party"
      source_type:
        | "manual_note"
        | "email"
        | "meeting"
        | "document"
        | "api"
        | "other"
      topic_status:
        | "active"
        | "waiting_client"
        | "pending_us"
        | "blocked"
        | "monitoring"
        | "resolved"
        | "archived"
      update_type: "note" | "fact" | "decision" | "status_change" | "milestone"
      workspace_role: "owner" | "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      actor_type: ["user", "ai", "system", "integration"],
      ai_proposal_status: [
        "pending",
        "approved",
        "rejected",
        "applied",
        "expired",
      ],
      ai_run_status: ["pending", "running", "completed", "failed", "cancelled"],
      client_health: ["good", "attention", "risk", "unknown"],
      commitment_status: ["open", "completed", "cancelled", "overdue"],
      decision_status: ["active", "superseded"],
      idempotency_status: ["in_progress", "completed", "failed"],
      party: ["us", "client", "third_party", "nobody"],
      priority_level: ["high", "medium", "low"],
      relationship_status: ["active", "paused", "archived"],
      responsible_party: ["us", "client", "third_party"],
      source_type: [
        "manual_note",
        "email",
        "meeting",
        "document",
        "api",
        "other",
      ],
      topic_status: [
        "active",
        "waiting_client",
        "pending_us",
        "blocked",
        "monitoring",
        "resolved",
        "archived",
      ],
      update_type: ["note", "fact", "decision", "status_change", "milestone"],
      workspace_role: ["owner", "admin", "member"],
    },
  },
} as const
