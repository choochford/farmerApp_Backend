import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A connection-level error here does not mean the request that triggered
  // it failed — pg's pool recovers automatically. Log and move on rather
  // than crashing the process.
  console.error('Unexpected Postgres pool error', err);
});

export async function query<T = any>(text: string, params?: any[]) {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T = any>(text: string, params?: any[]) {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
