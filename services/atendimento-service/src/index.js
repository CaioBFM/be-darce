require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 5001);
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Serviço de atendimento em execução.',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'atendimento-service' });
});

app.get('/db', async (req, res) => {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT NOW() AS current_time');
    return res.status(200).json({
      status: 'success',
      message: 'Conexão com o banco de dados estabelecida.',
      service: 'atendimento-service',
      database: {
        timestamp: result.rows[0].current_time,
        responseTimeMs: Date.now() - start,
      },
    });
  } catch (error) {
    console.error('Erro de conexão com o banco de atendimento:', error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Falha na conexão com o banco de dados.',
      service: 'atendimento-service',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Serviço de atendimento ouvindo na porta ${port}`);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});