import { useEffect, useState } from 'react'
import './App.css'

const services = [
  { key: 'usuarios', name: 'Usuários', database: 'PostgreSQL' },
  { key: 'atendimento', name: 'Atendimento', database: 'PostgreSQL' },
  { key: 'gamificacao-escrita', name: 'Gamificação — escrita', database: 'PostgreSQL' },
  { key: 'gamificacao-leitura', name: 'Gamificação — leitura', database: 'MongoDB' },
  { key: 'comunidade', name: 'Comunidade', database: 'MongoDB' },
  { key: 'saga-orquestrador', name: 'Orquestrador SAGA', database: 'PostgreSQL de Atendimento (compartilhado)' },
]

function App() {
  const [results, setResults] = useState({})
  const [loading, setLoading] = useState(false)
  const [sagaState, setSagaState] = useState(null)
  const [sagaLoading, setSagaLoading] = useState(true)
  const [sagaError, setSagaError] = useState('')
  const [selectedSaga, setSelectedSaga] = useState(null)
  const [workingUser, setWorkingUser] = useState('')
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [sagaMessage, setSagaMessage] = useState('')

  async function loadSaga() {
    setSagaLoading(true); setSagaError('')
    try {
      const response = await fetch('/admin/v1/saga/estado')
      const body = await response.json()
      if (!response.ok) throw new Error(body.message || body.error || 'Não foi possível carregar os dados da SAGA.')
      setSagaState(body)
    } catch (error) { setSagaError(error.message) }
    finally { setSagaLoading(false) }
  }

  useEffect(() => { loadSaga() }, [])

  async function promote(patient) {
    setWorkingUser(patient.usuarioId); setSagaMessage('')
    try {
      const response = await fetch('/admin/v1/saga/promocoes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuarioId: patient.usuarioId, simularFalhaComunidade: simulateFailure }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || result.message || 'A promoção não foi concluída.')
      setSagaMessage(result.mensagem || 'Execução SAGA registrada.')
      setSelectedSaga(result.promocao || null)
      await loadSaga()
    } catch (error) { setSagaMessage(error.message); await loadSaga() }
    finally { setWorkingUser('') }
  }

  async function viewSaga(id) {
    try {
      const response = await fetch(`/admin/v1/saga/promocoes/${encodeURIComponent(id)}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Não foi possível consultar a execução.')
      setSelectedSaga(body)
    } catch (error) { setSagaMessage(error.message) }
  }

  async function requestCheck(service, operation) {
    try {
      const response = await fetch(
        `/admin/v1/diagnostics/services/${service.key}/${operation}`,
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
    <main className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-mark">B</span>
          <span>BEDARCE</span>
          <span className="admin-divider" />
          <span className="admin-panel-label">PAINEL ADMINISTRATIVO</span>
        </div>
        <span className="environment-tag">AMBIENTE LOCAL</span>
      </header>

      <section className="admin-content">
        <p className="admin-eyebrow">ADMINISTRAÇÃO · PROMOÇÃO DE MENTORES</p>
        <h1>Jornada de mentoria</h1>
        <p className="admin-intro">
          Acompanhe a promoção de pacientes aptos e os passos coordenados pela SAGA.
        </p>

        <section className="admin-diagnostics saga-panel" aria-live="polite">
          <div className="diagnostics-heading"><div><span className="admin-eyebrow">FLUXO DISTRIBUÍDO</span><h2>Pacientes e promoções</h2></div><button onClick={loadSaga} disabled={sagaLoading}>{sagaLoading ? 'Atualizando…' : 'Atualizar dados'}</button></div>
          {sagaError && <p className="saga-error">{sagaError}</p>}
          {sagaMessage && <p className="saga-message">{sagaMessage}</p>}
          {sagaLoading && !sagaState ? <p>Carregando dados reais dos serviços…</p> : sagaState && <>
            <div className="saga-flow">Atendimento <b>→</b> Usuários <b>→</b> Comunidade <b>→</b> Gamificação</div>
            <label className="failure-option"><input type="checkbox" checked={simulateFailure} onChange={(event) => setSimulateFailure(event.target.checked)} /> Simular falha na Comunidade (demonstrar compensação)</label>
            <div className="patient-list">{(sagaState.pacientes || []).map((patient) => {
              const user = (sagaState.usuarios || []).find((entry) => entry.id === patient.usuarioId)
              const role = user?.papel || '—'
              const mentor = (sagaState.mentores || []).some((entry) => entry.usuarioId === patient.usuarioId)
              return <article className="patient-row" key={patient.usuarioId}><div><strong>{patient.nome}</strong><span>{patient.usuarioId}</span></div><span className="role-badge">{role}</span><span className={patient.aptoMentor ? 'apt-status' : 'inapt-status'}>{patient.aptoMentor ? 'Apto' : 'Não apto'}</span><button disabled={!patient.aptoMentor || role !== 'PACIENTE' || workingUser !== ''} onClick={() => promote(patient)}>{workingUser === patient.usuarioId ? 'Executando…' : mentor ? 'Já é mentor' : 'Promover a mentor'}</button></article>
            })}</div>
            <div className="saga-history"><h3>Histórico de promoções</h3>{(sagaState.promocoes || []).length === 0 ? <p>Nenhuma promoção registrada.</p> : <ul>{sagaState.promocoes.map((item) => <li key={item.id}><button className="history-link" onClick={() => viewSaga(item.id)}>{item.usuario_id || item.usuarioId}</button><span>{item.status}</span><time>{new Date(item.criada_em || item.criadaEm).toLocaleString('pt-BR')}</time></li>)}</ul>}</div>
            {selectedSaga && <article className="saga-detail"><div className="detail-heading"><h3>Execução da SAGA</h3><button className="small-button" onClick={() => setSelectedSaga(null)}>Fechar</button></div><p><b>Paciente:</b> {selectedSaga.usuario_id || selectedSaga.usuarioId} · <b>Estado:</b> {selectedSaga.status} · <b>Etapa atual:</b> {selectedSaga.etapa_atual || selectedSaga.etapaAtual}</p><div className="saga-steps">{Object.entries(selectedSaga.passos || {}).map(([step, state]) => <div key={step}><span>{step}</span><strong>{state}</strong></div>)}</div>{selectedSaga.erro && <p className="saga-error">{selectedSaga.erro}</p>}{selectedSaga.compensacao && <p className="saga-message">{selectedSaga.compensacao}</p>}</article>}
          </>}
        </section>

        <section className="admin-diagnostics" aria-live="polite">
          <div className="diagnostics-heading">
            <div>
              <span className="admin-eyebrow">TESTE PONTA A PONTA</span>
              <h2>Serviços e bancos</h2>
            </div>
            <button type="button" onClick={checkAll} disabled={loading}>
              {loading ? 'Testando…' : 'Testar todos'}
            </button>
          </div>

          <div className="admin-service-grid">
            {services.map((service) => (
              <article className="admin-service-card" key={service.key}>
                <div className="admin-service-title">
                  <div>
                    <h3>{service.name}</h3>
                    <span>{service.database}</span>
                  </div>
                  <code>{service.key}</code>
                </div>
                <div className="admin-check-line">
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
                <div className="admin-check-line">
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
      </section>

      <footer className="admin-footer">
        <span>BEDARCE · diagnóstico administrativo</span>
        <span>Os bancos não são acessados diretamente pelo front-end.</span>
      </footer>
    </main>
  )
}

export default App
