require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const port = Number(process.env.PORT || 8080);
const internalPort = Number(process.env.INTERNAL_PORT || 8081);
const portalUrl = process.env.BFF_PORTAL_URL || 'http://bff-portal:4000';
const adminUrl = process.env.BFF_ADMIN_URL || 'http://bff-admin:4001';
const serviceTargets = {
  usuarios: `http://usuarios-service:${process.env.PORT_USUARIOS || 5000}`,
  atendimento: `http://atendimento-service:${process.env.PORT_ATENDIMENTO || 5001}`,
  'gamificacao-escrita': `http://gamificacao-escrita-service:${process.env.PORT_GAMIFICACAO_ESCRITA || 5002}`,
  'gamificacao-leitura': `http://gamificacao-leitura-service:${process.env.PORT_GAMIFICACAO_LEITURA || 5003}`,
  comunidade: `http://comunidade-service:${process.env.PORT_COMUNIDADE || 5004}`,
  'saga-orquestrador': `http://saga-orquestrador:${process.env.PORT_SAGA || 5005}`,
  assistente: `http://assistente-service:${process.env.PORT_ASSISTENTE || 5006}`,
};

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'gateway',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'gateway' });
});

const proxyError = (service) => (error, req, res) => {
  console.error(`Falha no proxy para ${service}:`, error.message);
  if (!res.headersSent) {
    const timeout = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET'].includes(error.code);
    res.status(timeout ? 504 : 502).json({
      status: 'error',
      message: timeout
        ? `Tempo limite excedido ao aguardar ${service}.`
        : `Serviço ${service} indisponível.`,
    });
  }
};

app.use(
  '/portal/v1',
  createProxyMiddleware({
    target: portalUrl,
    changeOrigin: true,
    timeout: 125000,
    proxyTimeout: 120000,
    pathRewrite: (path) => `/v1${path}`,
    on: { error: proxyError('bff-portal') },
  }),
);

app.use(
  '/admin/v1',
  createProxyMiddleware({
    target: adminUrl,
    changeOrigin: true,
    pathRewrite: (path) => `/v1${path}`,
    on: { error: proxyError('bff-admin') },
  }),
);

app.use(
  '/usuarios/v1',
  createProxyMiddleware({
    target: serviceTargets.usuarios,
    changeOrigin: true,
    pathRewrite: (path) => `/v1${path}`,
    on: { error: proxyError('usuarios-service') },
  }),
);



// Listener interno: os BFFs usam esta porta para alcançar serviços pelo Gateway.
const internalApp = express();

internalApp.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'gateway-internal' });
});

async function encaminharSaga(req, res, { caminho, metodo }) {
  const target = serviceTargets['saga-orquestrador'];
  try {
    const response = await fetch(`${target}${caminho}`, {
      method: metodo,
      ...(metodo === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    const timeout = error.name === 'TimeoutError';
    return res.status(timeout ? 504 : 502).json({ status: 'error', message: timeout ? 'Tempo limite excedido ao aguardar o orquestrador SAGA.' : 'Orquestrador SAGA indisponível.' });
  }
}

internalApp.get('/v1/services/saga-orquestrador/demo/estado', (req, res) => encaminharSaga(req, res, { caminho: '/v1/demo/estado', metodo: 'GET' }));
internalApp.get('/v1/services/saga-orquestrador/promocoes-mentor', (req, res) => encaminharSaga(req, res, { caminho: '/v1/promocoes-mentor', metodo: 'GET' }));
internalApp.get('/v1/services/saga-orquestrador/promocoes-mentor/:id', (req, res) => encaminharSaga(req, res, { caminho: `/v1/promocoes-mentor/${encodeURIComponent(req.params.id)}`, metodo: 'GET' }));
internalApp.post('/v1/services/saga-orquestrador/promocoes-mentor', express.json({ limit: '64kb' }), (req, res) => encaminharSaga(req, res, { caminho: '/v1/promocoes-mentor', metodo: 'POST' }));

async function encaminharAssistente(req, res, { caminho, metodo }) {
  const target = serviceTargets.assistente;
  try {
    const response = await fetch(`${target}${caminho}`, {
      method: metodo,
      ...(metodo === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body || {}) }
        : {}),
      signal: AbortSignal.timeout(110000),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    const timeout = error.name === 'TimeoutError';
    console.error('Falha no Gateway interno para assistente:', error.message);
    return res.status(timeout ? 504 : 502).json({
      status: 'error',
      message: timeout
        ? 'Tempo limite excedido ao aguardar assistente.'
        : 'Não foi possível alcançar assistente pelo Gateway interno.',
    });
  }
}

internalApp.post('/v1/services/assistente/assistente/boas-vindas', express.json({ limit: '16kb' }), (req, res) => (
  encaminharAssistente(req, res, { caminho: '/v1/assistente/boas-vindas', metodo: 'POST' })
));
internalApp.post('/v1/services/assistente/assistente/mensagem', express.json({ limit: '128kb' }), (req, res) => (
  encaminharAssistente(req, res, { caminho: '/v1/assistente/mensagem', metodo: 'POST' })
));
internalApp.get('/v1/services/assistente/assistente/metricas', (req, res) => (
  encaminharAssistente(req, res, { caminho: '/v1/assistente/metricas', metodo: 'GET' })
));

async function encaminharGamificacao(req, res, { servico, caminho, metodo }) {
  const target = serviceTargets[servico];
  const query = new URLSearchParams(req.query).toString();
  const url = `${target}${caminho}${query ? `?${query}` : ''}`;
  const headers = {};
  const usuarioId = req.get('X-Usuario-Id');
  if (usuarioId) headers['X-Usuario-Id'] = usuarioId;
  if (metodo === 'POST') headers['Content-Type'] = req.get('Content-Type') || 'application/json';

  try {
    const response = await fetch(url, {
      method: metodo,
      headers,
      ...(metodo === 'POST' && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.status(response.status).send(body);
  } catch (error) {
    const timeout = error.name === 'TimeoutError';
    console.error(`Falha no Gateway interno para ${servico}:`, error.message);
    return res.status(timeout ? 504 : 502).json({
      status: 'error',
      message: timeout
        ? `Tempo limite excedido ao aguardar ${servico}.`
        : `Não foi possível alcançar ${servico} pelo Gateway interno.`,
    });
  }
}

// Rotas internas explícitas: nenhuma rota /v1/internal dos microsserviços é encaminhada.
internalApp.post('/v1/services/gamificacao-escrita/etapas/:id/conclusao', express.json({ limit: '256kb' }), (req, res) => {
  return encaminharGamificacao(req, res, {
    servico: 'gamificacao-escrita',
    caminho: `/v1/etapas/${encodeURIComponent(req.params.id)}/conclusao`,
    metodo: 'POST',
  });
});

internalApp.get('/v1/services/gamificacao-leitura/usuarios/me/progresso', (req, res) => {
  return encaminharGamificacao(req, res, {
    servico: 'gamificacao-leitura',
    caminho: '/v1/usuarios/me/progresso',
    metodo: 'GET',
  });
});

internalApp.get('/v1/services/gamificacao-leitura/trilhas', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-leitura', caminho: '/v1/trilhas', metodo: 'GET',
}));

internalApp.get('/v1/services/gamificacao-leitura/trilhas/:id/etapas/:etapaId', (req, res) => encaminharGamificacao(req, res, {
  servico: 'gamificacao-leitura',
  caminho: `/v1/trilhas/${encodeURIComponent(req.params.id)}/etapas/${encodeURIComponent(req.params.etapaId)}`,
  metodo: 'GET',
}));

// Mantém o diagnóstico depois das rotas de produto para não interceptar consultas específicas.
internalApp.get('/v1/services/:service/:operation', async (req, res) => {
  const { service, operation } = req.params;
  const target = serviceTargets[service];

  if (!target || !['health', 'db'].includes(operation)) {
    return res.status(404).json({
      status: 'error',
      message: 'Serviço ou operação de diagnóstico não encontrado.',
    });
  }

  try {
    const response = await fetch(`${target}/${operation}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    return res.status(response.status).json(body);
  } catch (error) {
    console.error(`Falha no Gateway interno para ${service}:`, error.message);
    return res.status(502).json({
      status: 'error',
      message: `Não foi possível alcançar ${service} pelo Gateway interno.`,
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Gateway ouvindo na porta ${port}`);
});

internalApp.listen(internalPort, '0.0.0.0', () => {
  console.log(`Gateway interno ouvindo na porta ${internalPort}`);
});
