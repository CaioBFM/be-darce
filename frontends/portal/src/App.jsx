import { useEffect, useState } from 'react'
import './App.css'
import Assistente from './Assistente.jsx'

const services = [
  { key: 'usuarios', name: 'Usuários', database: 'PostgreSQL' },
  { key: 'atendimento', name: 'Atendimento', database: 'PostgreSQL' },
  { key: 'gamificacao-escrita', name: 'Gamificação — escrita', database: 'PostgreSQL' },
  { key: 'gamificacao-leitura', name: 'Gamificação — leitura', database: 'MongoDB' },
  { key: 'comunidade', name: 'Comunidade', database: 'MongoDB' },
  { key: 'saga-orquestrador', name: 'Orquestrador SAGA', database: 'PostgreSQL de Atendimento (compartilhado)' },
  { key: 'assistente', name: 'Assistente virtual', database: 'PostgreSQL + pgvector' },
]

const USER_ID = 'demo-portal-bed arce'.replace(' ', '')

function App() {
  const [trilhas, setTrilhas] = useState([])
  const [progresso, setProgresso] = useState(null)
  const [erroGamificacao, setErroGamificacao] = useState('')
  const [carregandoGamificacao, setCarregandoGamificacao] = useState(true)
  const [etapaAtiva, setEtapaAtiva] = useState(null)
  const [quiz, setQuiz] = useState([])
  const [respostas, setRespostas] = useState({})
  const [mensagem, setMensagem] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [results, setResults] = useState({})
  const [loading, setLoading] = useState(false)

  const headers = { 'X-Usuario-Id': USER_ID }
  async function carregarGamificacao() {
    setCarregandoGamificacao(true)
    setErroGamificacao('')
    try {
      const [trilhasResponse, progressoResponse] = await Promise.all([
        fetch('/portal/v1/gamificacao/trilhas', { headers }),
        fetch('/portal/v1/gamificacao/progresso', { headers }),
      ])
      if (!trilhasResponse.ok || !progressoResponse.ok) throw new Error('Gamificação indisponível no momento. Tente novamente.')
      const [trilhasBody, progressoBody] = await Promise.all([trilhasResponse.json(), progressoResponse.json()])
      setTrilhas(trilhasBody.items || [])
      setProgresso(progressoBody)
    } catch (error) { setErroGamificacao(error.message) }
    finally { setCarregandoGamificacao(false) }
  }

  useEffect(() => { carregarGamificacao() }, [])

  async function abrirEtapa(trilha, etapa) {
    if (etapa.bloqueada || etapa.concluida) return
    setOcupado(true); setMensagem(''); setRespostas({})
    try {
      const response = await fetch(`/portal/v1/gamificacao/trilhas/${encodeURIComponent(trilha.id)}/etapas/${encodeURIComponent(etapa.id)}`, { headers })
      if (!response.ok) throw new Error('Não foi possível carregar esta etapa.')
      const body = await response.json()
      setEtapaAtiva({ ...body, trilhaNome: trilha.nome })
      setQuiz(body.quiz || [])
    } catch (error) { setMensagem(error.message) }
    finally { setOcupado(false) }
  }

  async function concluirEtapa() {
    if (!etapaAtiva) return
    setOcupado(true); setMensagem('')
    try {
      const response = await fetch(`/portal/v1/gamificacao/etapas/${encodeURIComponent(etapaAtiva.id)}/conclusao`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ respostas: quiz.map((questao) => ({ questaoId: questao.id, opcaoSelecionada: Number(respostas[questao.id]) })) }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || body.message || 'Não foi possível concluir a etapa.')
      setMensagem(`Etapa concluída! Você ganhou ${body.pontosGanhos} pontos.`)
      const versaoEsperada = (progresso?.sincronizacao?.versao || 0) + 1
      for (let tentativa = 0; tentativa < 10; tentativa += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const atualizacao = await fetch('/portal/v1/gamificacao/progresso', { headers })
        if (atualizacao.ok) {
          const atualizado = await atualizacao.json()
          if ((atualizado.sincronizacao?.versao || 0) >= versaoEsperada && atualizado.etapasConcluidas >= (progresso?.etapasConcluidas || 0) + 1) {
            setProgresso(atualizado)
            const lista = await fetch('/portal/v1/gamificacao/trilhas', { headers })
            if (lista.ok) setTrilhas((await lista.json()).items || [])
            setEtapaAtiva(null); return
          }
        }
      }
      setMensagem('Conclusão registrada. A leitura ainda está sincronizando; atualize em instantes.')
    } catch (error) { setMensagem(error.message) }
    finally { setOcupado(false) }
  }

  async function requestCheck(service, operation) {
    try {
      const response = await fetch(
        `/portal/v1/diagnostics/services/${service.key}/${operation}`,
      )
      const body = await response.json()
      return { ...body, httpStatus: response.status }
    } catch (error) {
      return {
        status: 'error',
        message: 'Não foi possível alcançar o Gateway.',
        detail: error.message,
      }
    }
  }

  async function checkOne(service, operation) {
    const key = `${service.key}:${operation}`
    setLoading(true)
    const result = await requestCheck(service, operation)
    setResults((current) => ({ ...current, [key]: result }))
    setLoading(false)
  }

  async function checkAll() {
    setLoading(true)
    const checks = await Promise.all(
      services.flatMap((service) =>
        ['health', 'db'].map(async (operation) => [
          `${service.key}:${operation}`,
          await requestCheck(service, operation),
        ]),
      ),
    )
    setResults(Object.fromEntries(checks))
    setLoading(false)
  }

  function renderResult(service, operation) {
    const result = results[`${service.key}:${operation}`]
    if (!result) return <span className="check-pending">Ainda não testado</span>
    const ok = result.status === 'success' || result.status === 'ok'
    if (!ok) return <span className="check-failed">{result.message}</span>
    if (operation === 'health') {
      return <span className="check-passed">Saudável · HTTP {result.httpStatus}</span>
    }

    const databaseResult = result.database?.timestamp
      ? `Banco respondeu em ${result.database.responseTimeMs} ms`
      : `Ping do banco: ${result.database?.ping ? 'OK' : 'sem resposta'}`
    return (
      <span className="check-passed">
        {databaseResult} · HTTP {result.httpStatus}
      </span>
    )
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BEDARCE início">
          <span className="brand-mark">B</span>
          <span>BEDARCE</span>
        </a>
        <span className="client-label">Portal do usuário</span>
      </header>

      <section className="hero">
        <p className="eyebrow">APOIO, ACOLHIMENTO E RECUPERAÇÃO</p>
        <h1>Um passo de cada vez.</h1>
        <p className="intro">Acompanhe sua jornada, avance no seu ritmo e celebre cada conquista.</p>
      </section>

      <Assistente usuarioId={USER_ID} />

      <section className="diagnostic-card gamification" aria-live="polite">
        <div className="card-heading"><div><p className="eyebrow">SUA JORNADA</p><h2>Gamificação</h2></div><span className="demo-user">Demonstração · {USER_ID}</span></div>
        {carregandoGamificacao ? <p>Carregando seu progresso…</p> : erroGamificacao ? <div className="result result-error">{erroGamificacao} <button onClick={carregarGamificacao}>Tentar novamente</button></div> : <>
          <div className="score-panel"><div><span>Pontuação atual</span><strong>{progresso?.pontosTotais ?? 0} <small>pontos</small></strong></div><div><span>Nível atual</span><strong>{progresso?.nivel ?? 1}</strong></div><div><span>Etapas concluídas</span><strong>{progresso?.etapasConcluidas ?? 0}<small> / {progresso?.totalEtapas ?? 0}</small></strong></div></div>
          <div className="level-progress"><div><span>Progresso do nível</span><span>{(progresso?.pontosTotais ?? 0) % 50} / 50 pontos</span></div><div className="progress-track"><i style={{ width: `${((progresso?.pontosTotais ?? 0) % 50) * 2}%` }} /></div></div>
          {mensagem && <p className="feedback">{mensagem}</p>}
          {trilhas.map((trilha) => <article className="trail" key={trilha.id}><div><h3>{trilha.nome}</h3><p>{trilha.descricao}</p></div><ol>{trilha.etapas.map((etapa) => { const estado = etapa.concluida ? 'Concluída' : etapa.bloqueada ? 'Bloqueada' : 'Disponível'; return <li key={etapa.id} className={etapa.concluida ? 'done' : etapa.bloqueada ? 'locked' : ''}><div className="step-info"><span className="step-state">{estado}</span><strong>{etapa.titulo}</strong><span>{etapa.pontuacao} pontos</span></div>{!etapa.concluida && <button className="small-button" disabled={etapa.bloqueada || ocupado} onClick={() => abrirEtapa(trilha, etapa)}>{etapa.bloqueada ? 'Bloqueada' : 'Concluir etapa'}</button>}</li> })}</ol></article>)}
        </>}
      </section>

      {etapaAtiva && <div className="modal-backdrop"><section className="quiz-modal" aria-labelledby="quiz-title"><button className="close-button" onClick={() => setEtapaAtiva(null)} aria-label="Fechar">×</button><p className="eyebrow">{etapaAtiva.trilhaNome}</p><h2 id="quiz-title">{etapaAtiva.titulo}</h2><p>{etapaAtiva.conteudo}</p>{quiz.map((questao) => <fieldset key={questao.id}><legend>{questao.enunciado}</legend>{questao.opcoes.map((opcao, index) => <label key={opcao}><input type="radio" name={questao.id} value={index} checked={respostas[questao.id] === String(index)} onChange={(event) => setRespostas({ ...respostas, [questao.id]: event.target.value })} />{opcao}</label>)}</fieldset>)}{mensagem && <p className="feedback">{mensagem}</p>}<button onClick={concluirEtapa} disabled={ocupado || quiz.some((q) => respostas[q.id] === undefined)}>{ocupado ? 'Salvando…' : 'Concluir etapa'}</button></section></div>}

      <section className="diagnostic-card" aria-live="polite">
        <div className="card-heading">
          <div>
            <p className="eyebrow">CONECTIVIDADE</p>
            <h2>Serviços e bancos de dados</h2>
          </div>
          <button type="button" onClick={checkAll} disabled={loading}>
            {loading ? 'Testando…' : 'Testar todos'}
          </button>
        </div>

        <div className="service-grid">
          {services.map((service) => (
            <article className="service-card" key={service.key}>
              <div className="service-title">
                <div>
                  <h3>{service.name}</h3>
                  <span>{service.database}</span>
                </div>
                <span className="service-key">{service.key}</span>
              </div>
              <div className="check-line">
                <span>Serviço</span>
                {renderResult(service, 'health')}
                <button
                  type="button"
                  className="small-button"
                  onClick={() => checkOne(service, 'health')}
                  disabled={loading}
                >
                  Testar
                </button>
              </div>
              <div className="check-line">
                <span>Banco</span>
                {renderResult(service, 'db')}
                <button
                  type="button"
                  className="small-button"
                  onClick={() => checkOne(service, 'db')}
                  disabled={loading}
                >
                  Testar
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer>
        <span>BEDARCE · diagnóstico do Portal</span>
        <span>Todos os testes são encaminhados pelo Gateway.</span>
      </footer>
    </main>
  )
}

export default App
