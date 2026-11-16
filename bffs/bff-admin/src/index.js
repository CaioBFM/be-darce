require('dotenv').config();
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 4001);
const internalGatewayUrl =
  process.env.GATEWAY_INTERNAL_URL || 'http://gateway:8081';
const diagnosticServices = [
  'usuarios',
  'atendimento',
  'gamificacao-escrita',
  'gamificacao-leitura',
  'comunidade',
  'saga-orquestrador',
];

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bff-admin' });
});

app.get('/v1/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bff-admin' });
});

app.get('/v1/diagnostics/database', async (req, res) => {
  try {
    const response = await fetch(
      `${internalGatewayUrl}/v1/services/atendimento/db`,
      {
        signal: AbortSignal.timeout(7000),
      },
    );
    const result = await response.json();
    return res.status(response.status).json({
      ...result,
      checkedThrough: 'bff-admin -> gateway -> atendimento-service',
    });
  } catch (error) {
    console.error('Falha ao consultar o banco pelo BFF Admin:', error.message);
    return res.status(502).json({
      status: 'error',
      message: 'Não foi possível consultar o serviço de atendimento.',
    });
  }
});

app.get('/v1/diagnostics/services/:service/:operation', async (req, res) => {
  const { service, operation } = req.params;
  if (!diagnosticServices.includes(service) || !['health', 'db'].includes(operation)) {
    return res.status(404).json({
      status: 'error',
      message: 'Serviço ou operação de diagnóstico não encontrado.',
    });
  }

  try {
    const response = await fetch(
      `${internalGatewayUrl}/v1/services/${service}/${operation}`,
      { signal: AbortSignal.timeout(7000) },
    );
    const result = await response.json();
    return res.status(response.status).json({
      ...result,
      checkedThrough: `bff-admin -> gateway -> ${service}`,
    });
  } catch (error) {
    console.error(`Falha no diagnóstico do serviço ${service}:`, error.message);
    return res.status(502).json({
      status: 'error',
      message: `Não foi possível verificar ${service} pelo Gateway.`,
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`BFF Admin ouvindo na porta ${port}`);
});