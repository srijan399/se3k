import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

if (!process.env.DB_URL) {
  throw new Error('Missing DB_URL env var (Postgres connection string).');
}

const pool = new Pool({ connectionString: process.env.DB_URL });

export const db = drizzle(pool, { schema });
