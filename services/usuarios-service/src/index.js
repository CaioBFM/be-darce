require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const app = express(); app.use(express.json());
const port = Number(process.env.PORT || 5000);
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

async function initialize() {
  await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id VARCHAR(80) PRIMARY KEY, nome VARCHAR(150) NOT NULL,
    papel VARCHAR(30) NOT NULL DEFAULT 'PACIENTE', ativo BOOLEAN NOT NULL DEFAULT TRUE,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`INSERT INTO usuarios (id,nome,papel) VALUES
    ('paciente-001','Ana Souza','PACIENTE'), ('paciente-002','Bruno Lima','PACIENTE')
    ON CONFLICT (id) DO NOTHING`);
}
app.get('/', (req,res) => res.json({status:'ok',message:'Serviço de usuários em execução.'}));
app.get('/health',(req,res)=>res.json({status:'ok',service:'usuarios-service'}));
app.get('/db',async(req,res)=>{try{const r=await pool.query('SELECT NOW() AS current_time');res.json({status:'success',service:'usuarios-service',database:{timestamp:r.rows[0].current_time}});}catch(e){res.status(503).json({status:'error',message:'Falha na conexão com o banco.'});}});
app.get('/v1/usuarios',async(req,res)=>{try{const r=await pool.query('SELECT id,nome,papel,ativo FROM usuarios ORDER BY id');res.json(r.rows);}catch(e){res.status(500).json({error:'Erro ao listar usuários.'});}});
app.get('/v1/usuarios/:id',async(req,res)=>{try{const r=await pool.query('SELECT id,nome,papel,ativo FROM usuarios WHERE id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});res.json(r.rows[0]);}catch(e){res.status(500).json({error:'Erro ao consultar usuário.'});}});

// Passo 2: adiciona o papel de mentor. Repetir a chamada não duplica a alteração.
app.put('/internal/usuarios/:id/mentor',async(req,res)=>{
  try {
    const r=await pool.query("UPDATE usuarios SET papel='MENTOR',atualizado_em=NOW() WHERE id=$1 AND papel='PACIENTE' RETURNING id,nome,papel",[req.params.id]);
    if(r.rowCount)return res.json({...r.rows[0],acao:'PAPEL_ADICIONADO'});
    const atual=await pool.query('SELECT id,nome,papel FROM usuarios WHERE id=$1',[req.params.id]);
    if(!atual.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});
    if(atual.rows[0].papel==='MENTOR')return res.json({...atual.rows[0],acao:'JA_E_MENTOR'});
    return res.status(409).json({error:'Usuário não pode ser promovido a partir do papel atual.'});
  } catch(e){res.status(500).json({error:'Erro ao adicionar papel de mentor.'});}
});

// Compensação: remove MENTOR e restaura PACIENTE.
app.delete('/internal/usuarios/:id/mentor',async(req,res)=>{
  try {
    const r=await pool.query("UPDATE usuarios SET papel='PACIENTE',atualizado_em=NOW() WHERE id=$1 AND papel='MENTOR' RETURNING id,nome,papel",[req.params.id]);
    if(r.rowCount)return res.status(200).json({...r.rows[0],acao:'COMPENSACAO_EXECUTADA'});
    const atual=await pool.query('SELECT id,nome,papel FROM usuarios WHERE id=$1',[req.params.id]);
    if(!atual.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});
    if(atual.rows[0].papel==='PACIENTE')return res.status(200).json({...atual.rows[0],acao:'JA_COMPENSADO'});
    return res.status(409).json({error:'Não foi possível compensar o papel atual.'});
  } catch(e){res.status(500).json({error:'Erro ao executar compensação.'});}
});
initialize().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Usuários ouvindo na porta ${port}`))).catch(e=>{console.error('Falha ao inicializar Usuários:',e);process.exit(1);});
process.on('SIGTERM',async()=>{await pool.end();process.exit(0);});
