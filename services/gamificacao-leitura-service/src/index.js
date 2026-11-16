require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
const port = Number(process.env.PORT || 5003);
const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Serviço de leitura da gamificação em execução.',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'gamificacao-leitura-service',
  });
});

app.get('/db', async (req, res) => {
  const start = Date.now();
  try {
    const result = await client.db().admin().command({ ping: 1 });
    return res.status(200).json({
      status: 'success',
      message: 'Conexão com o banco de dados estabelecida.',
      service: 'gamificacao-leitura-service',
      database: {
        ping: result.ok,
        responseTimeMs: Date.now() - start,
      },
    });
  } catch (error) {
    console.error('Erro de conexão com o MongoDB de gamificação:', error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Falha na conexão com o banco de dados.',
      service: 'gamificacao-leitura-service',
    });
  }
});

async function start() {
  try {
    await client.connect();
    app.listen(port, '0.0.0.0', () => {
      console.log(`Serviço de leitura ouvindo na porta ${port}`);
    });
  } catch (error) {
    console.error('Não foi possível iniciar o serviço de leitura:', error.message);
    process.exitCode = 1;
  }
}

start();

process.on('SIGTERM', async () => {
  await client.close();
  process.exit(0);
});