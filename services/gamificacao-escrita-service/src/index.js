require('dotenv').config();
const express = require('express');
const { pool, aguardarBanco, migrar } = require('./db');
const { semear } = require('./seed');
const { iniciarRelay } = require('./relay');
const { concluirEtapa, criarTrilha, criarEtapa } = require('./comandos');
const { ErroHttp, enviarProblema } = require('./erros');

const app = express();
const port = Number(process.env.PORT || 5002);
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

app.use(express.json({ limit: '256kb' }));

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Serviço de escrita da gamificação em execução.',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'gamificacao-escrita-service',
  });
});

app.get('/db', async (req, res) => {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT NOW() AS current_time');
    return res.status(200).json({
      status: 'success',
      message: 'Conexão com o banco de dados estabelecida.',
      service: 'gamificacao-escrita-service',
      database: {
        timestamp: result.rows[0].current_time,
        responseTimeMs: Date.now() - start,
      },
    });
  } catch (error) {
    console.error('Erro de conexão com o banco de gamificação:', error.message);
    return res.status(503).json({
      status: 'error',
      message: 'Falha na conexão com o banco de dados.',
      service: 'gamificacao-escrita-service',
    });
  }
});

// O Gateway/BFF valida o token e repassa o id do usuário autenticado neste cabeçalho.
function usuarioAutenticado(req) {
  const usuarioId = req.get('X-Usuario-Id');
  if (!usuarioId) throw new ErroHttp(401, 'UNAUTHORIZED', 'Cabeçalho X-Usuario-Id ausente.');
  if (!ID_VALIDO.test(usuarioId)) throw new ErroHttp(400, 'VALIDATION_ERROR', 'X-Usuario-Id inválido.');
  return usuarioId;
}

// Comando: conclui a etapa e devolve, de forma síncrona, pontos e nível atualizados.
app.post('/v1/etapas/:id/conclusao', async (req, res) => {
  const usuarioId = usuarioAutenticado(req);
  const resultado = await concluirEtapa({
    usuarioId,
    etapaId: req.params.id,
    respostas: req.body?.respostas,
  });
  res.status(200).json(resultado);
});

// Comandos administrativos de conteúdo.
app.post('/v1/trilhas', async (req, res) => {
  const trilha = await criarTrilha(req.body);
  res.status(201).location(`/v1/trilhas/${trilha.id}`).json(trilha);
});

app.post('/v1/trilhas/:trilhaId/etapas', async (req, res) => {
  const etapa = await criarEtapa(req.params.trilhaId, req.body);
  res.status(201).location(`/v1/trilhas/${req.params.trilhaId}/etapas/${etapa.id}`).json(etapa);
});

// Observabilidade da outbox (rota interna, não exposta pelo Gateway).
app.get('/v1/internal/outbox', async (req, res) => {
  const status = req.query.status;
  if (status && !['PENDENTE', 'ENVIADO', 'FALHA'].includes(status)) {
    throw new ErroHttp(400, 'VALIDATION_ERROR', 'status deve ser PENDENTE, ENVIADO ou FALHA.');
  }
  const limite = Math.min(Math.max(Number(req.query.limite) || 20, 1), 200);
  const [{ rows: resumo }, { rows: eventos }] = await Promise.all([
    pool.query('SELECT status, COUNT(*)::int AS total FROM outbox GROUP BY status'),
    pool.query(
      `SELECT id, tipo_evento, agregado_id, destino, status, tentativas, proximo_envio,
              ultimo_erro, criado_em, enviado_em,
              (EXTRACT(EPOCH FROM (enviado_em - criado_em)) * 1000)::int AS defasagem_ms
       FROM outbox
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY criado_em DESC
       LIMIT $2`,
      [status || null, limite],
    ),
  ]);
  res.status(200).json({
    resumo: Object.fromEntries(['PENDENTE', 'ENVIADO', 'FALHA'].map((s) => [
      s,
      resumo.find((linha) => linha.status === s)?.total || 0,
    ])),
    eventos,
  });
});

// Reenfileira um evento em FALHA depois da análise manual.
app.post('/v1/internal/outbox/:id/reprocessamento', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE outbox SET status = 'PENDENTE', tentativas = 0, proximo_envio = NOW(), ultimo_erro = NULL
     WHERE id::text = $1 AND status = 'FALHA'
     RETURNING id, status`,
    [req.params.id],
  );
  if (!rows[0]) throw new ErroHttp(404, 'NOT_FOUND', 'Evento em FALHA não encontrado.');
  res.status(200).json(rows[0]);
});

app.use((req, res) => enviarProblema(res, req, 404, 'NOT_FOUND', 'Rota não encontrada.'));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error instanceof ErroHttp) return enviarProblema(res, req, error.status, error.code, error.message);
  if (error.type === 'entity.parse.failed') {
    return enviarProblema(res, req, 400, 'VALIDATION_ERROR', 'Corpo JSON inválido.');
  }
  console.error('Erro inesperado no serviço de escrita:', error);
  return enviarProblema(res, req, 500, 'INTERNAL_ERROR', 'Erro inesperado ao processar o comando.');
});

let pararRelay = () => {};

async function start() {
  try {
    await aguardarBanco();
    await migrar();
    await semear();
    pararRelay = iniciarRelay();
    app.listen(port, '0.0.0.0', () => {
      console.log(`Serviço de escrita ouvindo na porta ${port}`);
    });
  } catch (error) {
    console.error('Não foi possível iniciar o serviço de escrita:', error.message);
    process.exit(1);
  }
}

start();

process.on('SIGTERM', async () => {
  pararRelay();
  await pool.end();
  process.exit(0);
});
