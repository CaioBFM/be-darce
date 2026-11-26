require('dotenv').config();
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 4001);
const internalGatewayUrl =
  process.env.GATEWAY_INTERNAL_URL || 'http://gateway:8081';
app.use(express.json({ limit: '256kb' }));
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

async function encaminharSaga(req, res, caminho, metodo = 'GET') {
  try {
    const response = await fetch(`${internalGatewayUrl}/v1/services/saga-orquestrador${caminho}`, {
      method: metodo,
      ...(metodo === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    console.error('Falha na chamada ao orquestrador SAGA:', error.message);
    return res.status(error.name === 'TimeoutError' ? 504 : 502).json({ status: 'error', message: 'Não foi possível consultar o orquestrador SAGA.' });
  }
}

app.get('/v1/saga/estado', (req, res) => encaminharSaga(req, res, '/demo/estado'));
app.get('/v1/saga/promocoes', (req, res) => encaminharSaga(req, res, '/promocoes-mentor'));
app.get('/v1/saga/promocoes/:id', (req, res) => encaminharSaga(req, res, `/promocoes-mentor/${encodeURIComponent(req.params.id)}`));
app.post('/v1/saga/promocoes', (req, res) => encaminharSaga(req, res, '/promocoes-mentor', 'POST'));

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
