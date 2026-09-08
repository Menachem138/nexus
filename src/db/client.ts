import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

export function createPool(connectionString?: string): pg.Pool {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env");
  }
  return new Pool({ connectionString: url });
}

export type Db = pg.Pool | pg.PoolClient;
