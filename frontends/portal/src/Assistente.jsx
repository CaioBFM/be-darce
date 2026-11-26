import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './Assistente.module.css'

const BOAS_VINDAS_PADRAO =
  'Olá! Sou o assistente virtual da BEDARCE — uma Inteligência Artificial com limitações, que não substitui acompanhamento profissional. Como você está se sentindo hoje?'

export default function Assistente({ usuarioId }) {
  const [mensagens, setMensagens] = useState([])
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const fim = useRef(null)
  const headers = useMemo(
    () => ({ 'X-Usuario-Id': usuarioId, 'Content-Type': 'application/json' }),
    [usuarioId],
  )

  useEffect(() => {
    let cancelado = false
    ;(async () => {
      try {
        const response = await fetch('/portal/v1/assistente/boas-vindas', { method: 'POST', headers, body: '{}' })
        const body = await response.json()
        if (!response.ok) throw new Error(body.message)
        if (!cancelado) setMensagens([{ papel: 'assistente', texto: body.mensagem }])
      } catch {
        if (!cancelado) setMensagens([{ papel: 'assistente', texto: BOAS_VINDAS_PADRAO }])
      }
    })()
    return () => { cancelado = true }
  }, [headers])

  useEffect(() => { fim.current?.scrollIntoView({ behavior: 'smooth' }) }, [mensagens, enviando])

  async function enviar(event) {
    event.preventDefault()
    const mensagem = texto.trim()
    if (!mensagem || enviando) return
    setMensagens((atual) => [...atual, { papel: 'usuario', texto: mensagem }])
    setTexto('')
    setEnviando(true)
    try {
      const response = await fetch('/portal/v1/assistente/mensagem', {
        method: 'POST', headers, body: JSON.stringify({ mensagem }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.message || 'Não foi possível obter resposta.')
      setMensagens((atual) => [...atual, {
        papel: 'assistente', texto: body.resposta, fontes: body.fontes,
        contingencia: body.fallback_utilizado, cache: body.cache_hit,
      }])
    } catch (error) {
      setMensagens((atual) => [...atual, { papel: 'assistente', texto: error.message, erro: true }])
    } finally {
      setEnviando(false)
    }
  }

  return (
    <section className={`diagnostic-card ${styles.chat}`} aria-live="polite">
      <div className="card-heading">
        <div><p className="eyebrow">APOIO</p><h2>Assistente virtual</h2></div>
      </div>
      <p className={styles.chatAviso}>
        Sou uma IA e posso errar. Não substituo psicólogos nem atendimento profissional.
      </p>
      <div className={styles.chatJanela}>
        {mensagens.map((m, i) => (
          <div
            key={i}
            className={`${styles.chatMsg} ${styles[`chat${m.papel[0].toUpperCase()}${m.papel.slice(1)}`]}${m.erro ? ` ${styles.chatErro}` : ''}`}
          >
            <p>{m.texto}</p>
            {m.contingencia && <small className={styles.chatTag}>Modo de contingência: IA temporariamente indisponível</small>}
            {m.fontes?.length > 0 && <small className={styles.chatFontes}>Fontes: {m.fontes.join(', ')}</small>}
          </div>
        ))}
        {enviando && <div className={`${styles.chatMsg} ${styles.chatAssistente}`}><p>Pensando…</p></div>}
        <div ref={fim} />
      </div>
      <form className={styles.chatForm} onSubmit={enviar}>
        <input
          value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={1000}
          placeholder="Escreva sua mensagem…" disabled={enviando} aria-label="Mensagem para o assistente"
        />
        <button type="submit" disabled={enviando || !texto.trim()}>Enviar</button>
      </form>
    </section>
  )
}