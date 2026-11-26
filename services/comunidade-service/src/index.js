require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const app = express(); app.use(express.json());
const port = Number(process.env.PORT || 5004);
const client = new MongoClient(process.env.MONGO_URI);
let mentores;
app.get('/',(req,res)=>res.json({status:'ok',message:'Serviço da comunidade em execução.'}));
app.get('/health',(req,res)=>res.json({status:'ok',service:'comunidade-service'}));
app.get('/db',async(req,res)=>{try{const r=await client.db().admin().command({ping:1});res.json({status:'success',service:'comunidade-service',database:{ping:r.ok}});}catch(e){res.status(503).json({status:'error',message:'Falha na conexão com o MongoDB.'});}});

// Passo pivô: criar o perfil oficial torna a promoção definitiva.
app.post('/internal/mentores',async(req,res)=>{
  const {usuarioId,nome,sagaId,simularFalha}=req.body||{};
  if(!usuarioId||!sagaId)return res.status(400).json({error:'usuarioId e sagaId são obrigatórios.'});
  try {
    // Falha controlada exclusivamente para a demonstração do caminho de compensação.
    if(simularFalha===true)return res.status(409).json({error:'A comunidade recusou a criação do perfil de mentor (falha simulada).',code:'PERFIL_REJEITADO'});
    const existente=await mentores.findOne({usuarioId});
    if(existente)return res.status(200).json({...existente,acao:'PERFIL_JA_EXISTENTE'});
    const mentor={usuarioId,nome:nome||'Novo mentor',sagaId,status:'ATIVO',criadoEm:new Date()};
    await mentores.insertOne(mentor);
    return res.status(201).json({...mentor,acao:'PERFIL_CRIADO'});
  }catch(e){return res.status(500).json({error:'Erro ao criar perfil na comunidade.'});}
});
app.get('/v1/mentores',async(req,res)=>{try{res.json(await mentores.find({}, {projection:{_id:0}}).toArray());}catch(e){res.status(500).json({error:'Erro ao listar mentores.'});}});
async function start(){try{await client.connect();mentores=client.db().collection('mentores');await mentores.createIndex({usuarioId:1},{unique:true});app.listen(port,'0.0.0.0',()=>console.log(`Comunidade ouvindo na porta ${port}`));}catch(e){console.error('Falha ao iniciar Comunidade:',e);process.exit(1);}}
start();
process.on('SIGTERM',async()=>{await client.close();process.exit(0);});
