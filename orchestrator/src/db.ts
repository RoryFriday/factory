import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface PbiRow {
  id: number;
  feature: string;
  pbi_number: string;
  file_path: string;
  depends_on: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: number;
  pbi_id: number;
  container_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  agent_summary: string | null;
  raw_log_path: string | null;
}

export interface GateResultRow {
  id: number;
  run_id: number;
  gate_type: string;
  status: string;
  detail: string | null;
  created_at: Date;
}