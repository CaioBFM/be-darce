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
    res.status(502).json({
      status: 'error',
      message: `Serviço ${service} indisponível.`,
    });
  }
};

app.use(
  '/saga/v1',
  createProxyMiddleware({
    target: `http://saga-orquestrador:${process.env.PORT_SAGA || 5005}`,
    changeOrigin: true,
    pathRewrite: (path) => `/v1${path}`,
    on: { error: proxyError('saga-orquestrador') },
  }),
);

app.use(
  '/portal/v1',
  createProxyMiddleware({
    target: portalUrl,
    changeOrigin: true,
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

// Listener interno: os BFFs usam esta porta para alcançar serviços pelo Gateway.
const internalApp = express();

internalApp.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'gateway-internal' });
});

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