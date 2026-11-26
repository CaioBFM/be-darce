require('dotenv').config();
const express = require('express');

const app = express();
const port = Number(process.env.PORT || 4000);
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
  'assistente',
];

async function encaminharGamificacao(req, res, { servico, caminho, metodo }) {
  const query = new URLSearchParams(req.query).toString();
  const url = `${internalGatewayUrl}/v1/services/${servico}${caminho}${query ? `?${query}` : ''}`;
  const headers = {};
  const usuarioId = req.get('X-Usuario-Id');
  if (usuarioId) headers['X-Usuario-Id'] = usuarioId;
  if (metodo === 'POST') headers['Content-Type'] = req.get('Content-Type') || 'application/json';

  try {
    const response = await fetch(url, {
      method: metodo,
      headers,
      ...(metodo === 'POST' && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    const timeout = error.name === 'TimeoutError';
    console.error(`Falha na chamada interna para ${servico}:`, error.message);
    return res.status(timeout ? 504 : 502).json({
      status: 'error',
      message: timeout
        ? `Tempo limite excedido ao aguardar ${servico}.`
        : `Serviço ${servico} indisponível.`,
    });
  }
}

async function encaminharAssistente(req, res, caminho) {
  const usuarioId = req.get('X-Usuario-Id');
  const payload = { ...(req.body || {}) };
  if (usuarioId && !payload.usuario_id) payload.usuario_id = usuarioId;

  try {
    const response = await fetch(
      `${internalGatewayUrl}/v1/services/assistente${caminho}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(usuarioId ? { 'X-Usuario-Id': usuarioId } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(115000),
      },
    );
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    const timeout = error.name === 'TimeoutError';
    console.error('Falha na chamada interna para assistente:', error.message);
    return res.status(timeout ? 504 : 502).json({
      status: 'error',
      message: timeout
        ? 'Tempo limite excedido ao aguardar o assistente.'
        : 'Serviço assistente indisponível.',
    });
  }
}

app.post('/v1/assistente/boas-vindas', (req, res) => (
  encaminharAssistente(req, res, '/assistente/boas-vindas')
));

app.post('/v1/assistente/mensagem', (req, res) => (
  encaminharAssistente(req, res, '/assistente/mensagem')
));

app.post('/v1/gamificacao/etapas/:id/conclusao', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-escrita',
  caminho: `/etapas/${encodeURIComponent(req.params.id)}/conclusao`,
  metodo: 'POST',
}));

app.get('/v1/gamificacao/progresso', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-leitura',
  caminho: '/usuarios/me/progresso',
  metodo: 'GET',
}));

app.get('/v1/gamificacao/trilhas', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-leitura', caminho: '/trilhas', metodo: 'GET',
}));

app.get('/v1/gamificacao/trilhas/:id/etapas/:etapaId', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-leitura',
  caminho: `/trilhas/${encodeURIComponent(req.params.id)}/etapas/${encodeURIComponent(req.params.etapaId)}`,
  metodo: 'GET',
}));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bff-portal' });
});

app.get('/v1/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bff-portal' });
});

app.get('/v1/diagnostics/database', async (req, res) => {
  try {
    const response = await fetch(
      `${internalGatewayUrl}/v1/services/usuarios/db`,
      {
      signal: AbortSignal.timeout(5000),
      },
    );
    const result = await response.json();
    return res.status(response.status).json({
      ...result,
      checkedThrough: 'bff-portal -> gateway -> usuarios-service',
    });
  } catch (error) {
    console.error('Falha ao consultar o banco pelo BFF Portal:', error.message);
    return res.status(502).json({
      status: 'error',
      message: 'Não foi possível consultar o serviço de usuários.',
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
      checkedThrough: `bff-portal -> gateway -> ${service}`,
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
  console.log(`BFF Portal ouvindo na porta ${port}`);
});
