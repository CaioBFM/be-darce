require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
const port = Number(process.env.PORT || 5001);
const pool = new Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

async function initialize() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pacientes (
      usuario_id VARCHAR(80) PRIMARY KEY,
      nome VARCHAR(150) NOT NULL,
      apto_mentor BOOLEAN NOT NULL DEFAULT TRUE,
      motivo_bloqueio TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promocoes_mentor (
      id UUID PRIMARY KEY,
      usuario_id VARCHAR(80) NOT NULL,
      status VARCHAR(40) NOT NULL,
      etapa_atual VARCHAR(50) NOT NULL,
      passos JSONB NOT NULL DEFAULT '{}'::jsonb,
      erro TEXT,
      compensacao TEXT,
      criada_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_promocoes_usuario ON promocoes_mentor(usuario_id);
  `);
  await pool.query(`INSERT INTO pacientes (usuario_id, nome, apto_mentor) VALUES
    ('paciente-001', 'Ana Souza', TRUE),
    ('paciente-002', 'Bruno Lima', TRUE)
    ON CONFLICT (usuario_id) DO NOTHING`);
}

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Serviço de atendimento em execução.' }));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'atendimento-service' }));
app.get('/db', async (req, res) => {
  try { const r = await pool.query('SELECT NOW() AS current_time'); res.json({ status: 'success', service: 'atendimento-service', database: { timestamp: r.rows[0].current_time } }); }
  catch (e) { res.status(503).json({ status: 'error', message: 'Falha na conexão com o banco de dados.' }); }
});

// Registro que representa a aprovação prévia do psicólogo no Atendimento.
app.get('/internal/pacientes/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT usuario_id AS "usuarioId", nome, apto_mentor AS "aptoMentor", motivo_bloqueio AS "motivoBloqueio" FROM pacientes WHERE usuario_id=$1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Paciente não encontrado no Atendimento.' });
    return res.json(r.rows[0]);
  } catch (e) { return res.status(500).json({ error: 'Erro ao consultar paciente.' }); }
});
app.get('/v1/pacientes', async (req, res) => {
  try { const r = await pool.query('SELECT usuario_id AS "usuarioId", nome, apto_mentor AS "aptoMentor" FROM pacientes ORDER BY usuario_id'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro ao listar pacientes.' }); }
});

// A SAGA mantém seu estado neste banco, pertencente ao Atendimento.
app.post('/internal/promocoes', async (req, res) => {
  const { id, usuarioId } = req.body || {};
  if (!id || !usuarioId) return res.status(400).json({ error: 'id e usuarioId são obrigatórios.' });
  try {
    const existente = await pool.query('SELECT * FROM promocoes_mentor WHERE id=$1', [id]);
    if (existente.rowCount) return res.status(200).json(existente.rows[0]);
    const paciente = await pool.query('SELECT apto_mentor, motivo_bloqueio FROM pacientes WHERE usuario_id=$1', [usuarioId]);
    if (!paciente.rowCount) return res.status(404).json({ error: 'Paciente não encontrado no Atendimento.' });
    if (!paciente.rows[0].apto_mentor) return res.status(409).json({ error: paciente.rows[0].motivo_bloqueio || 'Paciente não está apto para ser mentor.' });
    const passos = { atendimento: 'CONCLUIDO', usuarios: 'PENDENTE', comunidade: 'PENDENTE', gamificacao: 'PENDENTE' };
    const r = await pool.query(`INSERT INTO promocoes_mentor (id, usuario_id, status, etapa_atual, passos)
      VALUES ($1,$2,'EM_ANDAMENTO','ATENDIMENTO',$3::jsonb) RETURNING *`, [id, usuarioId, JSON.stringify(passos)]);
    return res.status(201).json(r.rows[0]);
  } catch (e) { return res.status(500).json({ error: 'Não foi possível iniciar a promoção.' }); }
});
app.patch('/internal/promocoes/:id', async (req, res) => {
  const { status, etapaAtual, passos, erro, compensacao } = req.body || {};
  try {
    const r = await pool.query(`UPDATE promocoes_mentor SET
      status=COALESCE($2,status), etapa_atual=COALESCE($3,etapa_atual),
      passos=COALESCE($4::jsonb,passos), erro=$5, compensacao=$6, atualizada_em=NOW()
      WHERE id=$1 RETURNING *`, [req.params.id, status || null, etapaAtual || null,
      passos ? JSON.stringify(passos) : null, erro ?? null, compensacao ?? null]);
    if (!r.rowCount) return res.status(404).json({ error: 'Promoção não encontrada.' });
    return res.json(r.rows[0]);
  } catch (e) { return res.status(500).json({ error: 'Não foi possível atualizar a promoção.' }); }
});
app.get('/internal/promocoes/:id', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM promocoes_mentor WHERE id=$1', [req.params.id]); if (!r.rowCount) return res.status(404).json({ error: 'Promoção não encontrada.' }); res.json(r.rows[0]); }
  catch (e) { res.status(500).json({ error: 'Erro ao consultar promoção.' }); }
});
app.get('/v1/promocoes-mentor', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM promocoes_mentor ORDER BY criada_em DESC'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Erro ao listar promoções.' }); }
});

initialize().then(() => app.listen(port, '0.0.0.0', () => console.log(`Atendimento ouvindo na porta ${port}`)))
  .catch(e => { console.error('Falha ao inicializar Atendimento:', e); process.exit(1); });
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
