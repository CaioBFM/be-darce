import { useState } from 'react'
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
        <p className="intro">
          Diagnóstico ponta a ponta: Portal → Gateway → BFF Portal → Gateway
          interno → serviço → banco de dados.
        </p>
      </section>

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
