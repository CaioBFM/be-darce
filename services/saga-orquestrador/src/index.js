require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const app = express(); app.use(express.json());
const port = Number(process.env.PORT || 5005);
const urls = {
  atendimento: process.env.ATENDIMENTO_URL || 'http://atendimento-service:5001',
  usuarios: process.env.USUARIOS_URL || 'http://usuarios-service:5000',
  comunidade: process.env.COMUNIDADE_URL || 'http://comunidade-service:5004',
  gamificacao: process.env.GAMIFICACAO_URL || 'http://gamificacao-escrita-service:5002',
};

async function request(url, options={}) {
  const response=await fetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(5000)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(body.error||body.message||`HTTP ${response.status}`);error.status=response.status;error.body=body;throw error;}
  return body;
}
async function atualizarSaga(id, alteracoes){return request(`${urls.atendimento}/internal/promocoes/${id}`,{method:'PATCH',body:JSON.stringify(alteracoes)});}
async function executarSaga(usuarioId, simularFalhaComunidade=false){
  const sagaId=randomUUID();
  const inicio=await request(`${urls.atendimento}/internal/promocoes`,{method:'POST',body:JSON.stringify({id:sagaId,usuarioId})});
  const passos=inicio.passos;
  passos.gamificacao='PENDENTE';
  let papelAdicionado=false;
  let pivoConfirmado=false;
  try {
    // Passo 1: Atendimento já validou aptidão e persistiu a execução.
    await atualizarSaga(sagaId,{etapaAtual:'USUARIOS'});

    // Passo 2: transação local no serviço de Usuários.
    await request(`${urls.usuarios}/internal/usuarios/${usuarioId}/mentor`,{method:'PUT',body:'{}'});
    papelAdicionado=true; passos.usuarios='CONCLUIDO';
    await atualizarSaga(sagaId,{passos,etapaAtual:'COMUNIDADE'});

    // Passo pivô: se a Comunidade aceitar, a promoção torna-se definitiva.
    const paciente=await request(`${urls.atendimento}/internal/pacientes/${usuarioId}`);
    await request(`${urls.comunidade}/internal/mentores`,{method:'POST',body:JSON.stringify({usuarioId,nome:paciente.nome,sagaId,simularFalha:simularFalhaComunidade})});
    passos.comunidade='CONCLUIDO';
    pivoConfirmado=true;
    await atualizarSaga(sagaId,{status:'EM_ANDAMENTO',etapaAtual:'PIVO_CONFIRMADO',passos,erro:null,compensacao:null});

    // Após o pivô, falhas são tratadas com retentativas, nunca com compensação.
    let erroGamificacao=null;
    for(let tentativa=1;tentativa<=3;tentativa++){
      try {
        await request(`${urls.gamificacao}/v1/internal/trilhas-mentor`,{method:'POST',body:JSON.stringify({usuarioId})});
        erroGamificacao=null; break;
      } catch(e) { erroGamificacao=e; if(tentativa<3) await new Promise(resolve=>setTimeout(resolve,300*tentativa)); }
    }
    if(erroGamificacao){
      passos.gamificacao='PENDENTE_RETRY';
      const pendente=await atualizarSaga(sagaId,{status:'PENDENTE_POS_PIVO',etapaAtual:'GAMIFICACAO',passos,erro:erroGamificacao.message,compensacao:null});
      return {mensagem:'Promoção confirmada; liberação da trilha pendente de nova tentativa.',erro:erroGamificacao.message,promocao:pendente};
    }
    passos.gamificacao='CONCLUIDO';
    const concluida=await atualizarSaga(sagaId,{status:'CONCLUIDA',etapaAtual:'FINALIZADA',passos,erro:null,compensacao:null});
    return {mensagem:'Paciente promovido a mentor e trilha de formação liberada.',promocao:concluida};
  } catch(error){
    // Depois do pivô, a promoção é definitiva: não desfazemos o papel do mentor.
    if(pivoConfirmado){
      passos.gamificacao='PENDENTE_RETRY';
      const pendente=await atualizarSaga(sagaId,{status:'PENDENTE_POS_PIVO',etapaAtual:'GAMIFICACAO',passos,erro:error.message,compensacao:null});
      return {mensagem:'Pivô confirmado. A etapa de Gamificação ficou pendente; a promoção foi preservada.',erro:error.message,promocao:pendente};
    }
    // Antes da confirmação do pivô, desfazemos em ordem inversa.
    if(papelAdicionado){
      try {
        // Persistir a etapa é best-effort: uma falha no registro não pode impedir a compensação real.
        await atualizarSaga(sagaId,{etapaAtual:'COMPENSANDO',passos,erro:error.message}).catch(()=>{});
        await request(`${urls.usuarios}/internal/usuarios/${usuarioId}/mentor`,{method:'DELETE'});
        passos.usuarios='COMPENSADO';
        passos.comunidade='FALHOU';
        const compensada=await atualizarSaga(sagaId,{status:'COMPENSADA',etapaAtual:'ENCERRADA_COM_COMPENSACAO',passos,erro:error.message,compensacao:'Papel MENTOR removido; usuário restaurado para PACIENTE.'});
        return {mensagem:'A Comunidade recusou a promoção. A compensação foi executada.',erro:error.message,promocao:compensada};
      } catch(erroCompensacao){
        const falha=await atualizarSaga(sagaId,{status:'FALHA_COMPENSACAO',etapaAtual:'FALHA_NA_COMPENSACAO',passos,erro:error.message,compensacao:erroCompensacao.message});
        return {mensagem:'A promoção falhou e a compensação também precisa de intervenção.',erro:error.message,promocao:falha};
      }
    }
    passos.atendimento='FALHOU';
    const falha=await atualizarSaga(sagaId,{status:'FALHA',etapaAtual:'ENCERRADA_COM_FALHA',passos,erro:error.message,compensacao:'Não necessária: o papel ainda não havia sido alterado.'});
    return {mensagem:'Não foi possível iniciar a promoção.',erro:error.message,promocao:falha};
  }
}

app.get('/',(req,res)=>res.json({status:'ok',service:'saga-orquestrador',mensagem:'Orquestrador da promoção de paciente para mentor.'}));
app.get('/health',(req,res)=>res.json({status:'ok',service:'saga-orquestrador'}));
app.get('/db',async(req,res)=>{try{const r=await request(`${urls.atendimento}/db`);res.json({...r,checkedThrough:'saga-orquestrador -> atendimento-service'});}catch(e){res.status(503).json({status:'error',message:e.message});}});

// POST /saga/v1/promocoes-mentor no Gateway.
app.post('/v1/promocoes-mentor',async(req,res)=>{
  const {usuarioId,simularFalhaComunidade=false}=req.body||{};
  if(!usuarioId)return res.status(400).json({error:'Informe usuarioId.'});
  if(typeof simularFalhaComunidade!=='boolean')return res.status(400).json({error:'simularFalhaComunidade deve ser booleano.'});
  try {
    const [usuario,paciente]=await Promise.all([
      request(`${urls.usuarios}/v1/usuarios/${usuarioId}`),
      request(`${urls.atendimento}/internal/pacientes/${usuarioId}`),
    ]);
    if(usuario.papel!=='PACIENTE')return res.status(409).json({error:'Somente usuários com papel PACIENTE podem ser promovidos.',papelAtual:usuario.papel});
    if(!paciente.aptoMentor)return res.status(409).json({error:'Paciente não está apto para ser mentor.',motivo:paciente.motivoBloqueio});
    const resultado=await executarSaga(usuarioId,simularFalhaComunidade);
    return res.status(resultado.promocao.status==='CONCLUIDA'?201:200).json(resultado);
  }catch(e){return res.status(e.status||502).json({error:e.message,service:'saga-orquestrador'});}
});
app.get('/v1/promocoes-mentor/:id',async(req,res)=>{try{res.json(await request(`${urls.atendimento}/internal/promocoes/${req.params.id}`));}catch(e){res.status(e.status||502).json({error:e.message});}});
app.get('/v1/promocoes-mentor',async(req,res)=>{try{res.json(await request(`${urls.atendimento}/v1/promocoes-mentor`));}catch(e){res.status(502).json({error:e.message});}});
app.get('/v1/demo/estado',async(req,res)=>{try{const [usuarios,mentores,pacientes,promocoes]=await Promise.all([request(`${urls.usuarios}/v1/usuarios`),request(`${urls.comunidade}/v1/mentores`),request(`${urls.atendimento}/v1/pacientes`),request(`${urls.atendimento}/v1/promocoes-mentor`)]);const trilhasMentor=await Promise.all(usuarios.map(u=>request(`${urls.gamificacao}/v1/internal/trilhas-mentor/${u.id}`)));res.json({pacientes,usuarios,mentores,trilhasMentor,promocoes});}catch(e){res.status(502).json({error:e.message,message:'Não foi possível consultar todos os serviços.'});}});
app.listen(port,'0.0.0.0',()=>console.log(`Orquestrador SAGA ouvindo na porta ${port}`));
