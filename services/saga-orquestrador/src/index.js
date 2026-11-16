require('dotenv').config();
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 5005);
const internalGatewayUrl =
  process.env.GATEWAY_INTERNAL_URL || 'http://gateway:8081';

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'saga-orquestrador',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'saga-orquestrador' });
});

// O estado da SAGA pertence a Atendimento e também é consultado pelo Gateway.
app.get('/db', async (req, res) => {
  try {
    const response = await fetch(
      `${internalGatewayUrl}/v1/services/atendimento/db`,
      {
      signal: AbortSignal.timeout(5000),
      },
    );
    const result = await response.json();
    return res.status(response.status).json({
      ...result,
      checkedThrough: 'saga-orquestrador -> gateway -> atendimento-service',
    });
  } catch (error) {
    console.error('Falha ao verificar o banco usado pela SAGA:', error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Não foi possível verificar o banco usado pela SAGA.',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Orquestrador SAGA ouvindo na porta ${port}`);
});