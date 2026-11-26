const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Número arbitrário e fixo: serializa a migração quando há réplicas subindo juntas.
const LOCK_MIGRACAO = 734001;

async function transacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function aguardarBanco(tentativas = 20, esperaMs = 1500) {
  for (let i = 1; i <= tentativas; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (i === tentativas) throw error;
      console.warn(`Banco de escrita indisponível (tentativa ${i}/${tentativas}): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, esperaMs));
    }
  }
}

async function migrar() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await transacao(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_MIGRACAO]);
    await client.query(sql);
  });
}

module.exports = { pool, transacao, aguardarBanco, migrar, LOCK_MIGRACAO };
