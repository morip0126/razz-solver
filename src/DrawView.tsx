import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DrawActionInfo,
  type DrawNode,
  replayDrawHistory,
} from './domain'
// ?worker&inline: 本体バンドルへ埋め込み（razz と同じ流儀）
import DrawWorker from './worker/drawWorker?worker&inline'
import type { DrawWorkerRequest, DrawWorkerResponse } from './worker/drawWorker'
import { type Lang, t } from './i18n'

const STACKS = [25, 50, 100] as const
const PRESETS = [
  { key: 'presetFast', iterations: 50000 },
  { key: 'presetStandard', iterations: 150000 },
  { key: 'presetFine', iterations: 400000 },
] as const

// 表示 thresholding（razz と同じ 5%）
const TH = 0.05

const PLAYER = ['BTN', 'BB']

function thresholded(freqs: readonly number[]): number[] {
  const kept = freqs.map((f) => (f < TH ? 0 : f))
  const total = kept.reduce((x, y) => x + y, 0)
  return total > 0 ? kept.map((f) => f / total) : [...freqs]
}

/** アクション → 表示色グループ。ドローは枚数で塗り分ける。 */
function groupOf(info: DrawActionInfo): 'fold' | 'call' | 'raise' {
  switch (info.kind) {
    case 'fold':
      return 'fold'
    case 'check':
    case 'call':
      return 'call'
    case 'draw':
      return info.count === 0 ? 'raise' : info.count === 1 ? 'call' : 'fold'
    default:
      return 'raise'
  }
}

function barBackground(actions: readonly DrawActionInfo[], freqs: readonly number[]): string {
  const order = { call: 0, raise: 1, fold: 2 }
  const parts = actions
    .map((a, i) => ({ g: groupOf(a), f: freqs[i] }))
    .sort((x, y) => order[x.g] - order[y.g])
  const stops: string[] = []
  let acc = 0
  for (const p of parts) {
    if (p.f <= 1e-4) continue
    stops.push(
      `var(--act-${p.g}) ${(acc * 100).toFixed(1)}% ${((acc + p.f) * 100).toFixed(1)}%`,
    )
    acc += p.f
  }
  return stops.length ? `linear-gradient(to right, ${stops.join(', ')})` : 'var(--panel2)'
}

function actionLabel(lang: Lang, info: DrawActionInfo): string {
  switch (info.kind) {
    case 'fold':
      return t(lang, 'fold')
    case 'check':
      return t(lang, 'check')
    case 'call':
      return `${t(lang, 'call')} ${info.toAmount}`
    case 'raise':
      return `${t(lang, 'raise')} ${info.toAmount}`
    case 'allin':
      return `${t(lang, 'allin')} ${info.toAmount}`
    case 'draw':
      return info.count === 0 ? t(lang, 'pat') : t(lang, 'drawN', { n: info.count! })
  }
}

const POST_LABEL: Record<string, { ja: string; en: string }> = {
  '75432': { ja: '75432（ナッツ）', en: '75432 (nuts)' },
  '7': { ja: '7ロー', en: '7-low' },
  '8s': { ja: '8ロー（スムーズ）', en: 'smooth 8' },
  '8': { ja: '8ロー', en: '8-low' },
  '9s': { ja: '9ロー（スムーズ）', en: 'smooth 9' },
  '9': { ja: '9ロー', en: '9-low' },
  T: { ja: 'Tロー', en: 'T-low' },
  J: { ja: 'Jロー', en: 'J-low' },
  Q: { ja: 'Qロー', en: 'Q-low' },
  K: { ja: 'Kロー', en: 'K-low' },
  A: { ja: 'Aロー', en: 'A-low' },
  pair: { ja: 'ワンペア', en: 'one pair' },
  trash: { ja: '2ペア以上/ストレート/フラッシュ', en: 'two pair+/straight/flush' },
}

function rowLabel(lang: Lang, row: DrawNode['rows'][number]): string {
  const l = row.label
  if (l.kind === 'post') return POST_LABEL[l.pat]?.[lang] ?? l.pat
  const pat = l.pat === '-' ? (lang === 'ja' ? '役なし' : 'no pat') : `${lang === 'ja' ? 'パット' : 'pat'} ${l.pat}`
  return `${pat} / 1→${l.draw1} / 2→${l.draw2}`
}

type SolveState =
  | { status: 'idle' }
  | { status: 'solving'; progress: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

export default function DrawView({ lang }: { lang: Lang }) {
  const [stackBb, setStackBb] = useState<number>(100)
  const [presetIdx, setPresetIdx] = useState(1)
  const [tokens, setTokens] = useState('')
  const [state, setState] = useState<SolveState>({ status: 'idle' })
  const [node, setNode] = useState<{ tokens: string; node: DrawNode } | null>(null)
  const [querying, setQuerying] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const idRef = useRef(0)
  const solvedKeyRef = useRef('')

  const configKey = `${stackBb}|${presetIdx}`

  useEffect(() => () => workerRef.current?.terminate(), [])

  const solve = () => {
    workerRef.current?.terminate()
    let worker: Worker
    try {
      worker = new DrawWorker()
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }
    workerRef.current = worker
    const id = ++idRef.current
    setState({ status: 'solving', progress: 0 })
    setNode(null)
    worker.onmessage = (e: MessageEvent<DrawWorkerResponse>) => {
      const msg = e.data
      if (msg.id !== id && msg.type !== 'node') return
      if (msg.type === 'progress') setState({ status: 'solving', progress: msg.done / msg.total })
      else if (msg.type === 'ready') {
        solvedKeyRef.current = configKey
        setState({ status: 'ready' })
        query(tokens)
      } else if (msg.type === 'node') {
        setNode({ tokens: msg.tokens, node: msg.node })
        setQuerying(false)
      } else {
        setState({ status: 'error', message: msg.message })
        setQuerying(false)
      }
    }
    const req: DrawWorkerRequest = {
      type: 'solve',
      id,
      config: { stackBb },
      iterations: PRESETS[presetIdx].iterations,
    }
    worker.postMessage(req)
  }

  const query = useCallback((tk: string) => {
    const worker = workerRef.current
    if (!worker) return
    setQuerying(true)
    const req: DrawWorkerRequest = { type: 'query', id: ++idRef.current, tokens: tk }
    worker.postMessage(req)
  }, [])

  const replay = (() => {
    try {
      return replayDrawHistory({ stackBb }, tokens)
    } catch {
      return null
    }
  })()

  // スタック変更などで履歴が不正になったら有効な部分まで切り詰める
  useEffect(() => {
    if (replay && replay.invalidAt >= 0) setTokens((s) => s.slice(0, replay.invalidAt))
  })

  const ready = state.status === 'ready' && solvedKeyRef.current === configKey
  const stale = state.status === 'ready' && solvedKeyRef.current !== configKey

  const pushToken = (token: string) => {
    const next = tokens + token
    setTokens(next)
    if (!ready) return
    try {
      if (!replayDrawHistory({ stackBb }, next).done) query(next)
      else setNode(null)
    } catch {
      /* 不正入力は effect が切り詰める */
    }
  }
  const undo = () => {
    const next = tokens.slice(0, -1)
    setTokens(next)
    if (ready) query(next)
  }
  const reset = () => {
    setTokens('')
    if (ready) query('')
  }

  const view = node && node.tokens === tokens && !replay?.done ? node.node : null
  const phaseKey =
    replay?.phase === 'pre' ? 'phasePre' : replay?.phase === 'draw' ? 'phaseDraw' : 'phasePost'

  return (
    <>
      <section className="panel controls">
        <div className="row">
          <label className="field">
            <span>{t(lang, 'stack')}</span>
            <select value={stackBb} onChange={(e) => setStackBb(Number(e.target.value))}>
              {STACKS.map((s) => (
                <option key={s} value={s}>{s} bb</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t(lang, 'precision')}</span>
            <select value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))}>
              {PRESETS.map((p, i) => (
                <option key={p.key} value={i}>{t(lang, p.key)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">{t(lang, 'drawSpotNote')}</p>

        <div className="action-builder">
          <p className="section-label">{t(lang, 'actionsLabel')}</p>

          {replay && replay.steps.length > 0 && (
            <div className="timeline">
              {replay.steps.map((s, i) => {
                const pct =
                  view || node?.tokens === tokens
                    ? node?.node.steps[i] && `${(node.node.steps[i].freq * 100).toFixed(0)}%`
                    : null
                return (
                  <span key={i} className={`step-chip step-${groupOf(s.info)}`}>
                    <b>{PLAYER[s.actor]}</b> {actionLabel(lang, s.info)}
                    {pct && <em className="step-pct">{pct}</em>}
                  </span>
                )
              })}
            </div>
          )}

          {replay && !replay.done && (
            <>
              <p className="next-line">
                {t(lang, 'nextToActDraw', { p: PLAYER[replay.actorIndex] })}
                <span className="pot-info">
                  {t(lang, phaseKey)} ・ {t(lang, 'potLabel', { n: replay.pot })}
                  {replay.toCall > 0 && <> ・ {t(lang, 'toCallLabel', { n: replay.toCall })}</>}
                </span>
              </p>
              <div className="builder-buttons">
                {replay.legal.map((a) => {
                  const ai = view ? view.actions.findIndex((x) => x.token === a.token) : -1
                  return (
                    <button
                      key={a.token}
                      type="button"
                      className={`action-button act-${groupOf(a)}`}
                      disabled={state.status === 'solving' || querying}
                      onClick={() => pushToken(a.token)}
                    >
                      {actionLabel(lang, a)}
                      {ai >= 0 && view && ` ${(view.totals[ai] * 100).toFixed(0)}%`}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {replay?.done && (
            <p className="hint done-note">
              {t(lang, replay.foldWin ? 'handOver' : 'showdownNote')}
            </p>
          )}

          {tokens.length > 0 && (
            <div className="builder-nav">
              <button type="button" className="nav-button" disabled={querying} onClick={undo}>
                {t(lang, 'undo')}
              </button>
              <button type="button" className="nav-button" disabled={querying} onClick={reset}>
                {t(lang, 'reset')}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="go-button"
          disabled={state.status === 'solving' || (ready && !stale)}
          onClick={solve}
        >
          {state.status === 'solving'
            ? t(lang, 'solving', { pct: Math.round(state.progress * 100) })
            : t(lang, 'go')}
        </button>
        {state.status === 'solving' && (
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${state.progress * 100}%` }} />
          </div>
        )}
        {stale && <p className="hint stale-note">{t(lang, 'staleResult')}</p>}
        {state.status === 'error' && <p className="error">{state.message}</p>}
      </section>

      {view && replay && !replay.done && (
        <section className="panel result">
          <h2 className="actor-title">
            {t(lang, 'drawActorTitle', { p: PLAYER[view.actorIndex], phase: t(lang, phaseKey) })}
          </h2>
          {querying && <p className="hint">…</p>}

          <div className="range-table">
            {view.rows
              .filter((r) => r.weight >= 0.002)
              .map((r) => {
                const freqs = thresholded(r.freqs)
                return (
                  <div key={r.bucket} className="range-row">
                    <span className="range-label">{rowLabel(lang, r)}</span>
                    <span className="range-weight">{(r.weight * 100).toFixed(1)}%</span>
                    <span
                      className="range-bar"
                      title={view.actions
                        .map((a, i) => `${actionLabel(lang, a)} ${(freqs[i] * 100).toFixed(0)}%`)
                        .join(' / ')}
                      style={{ background: barBackground(view.actions, freqs) }}
                    />
                  </div>
                )
              })}
          </div>

          <div className="legend">
            {replay.phase === 'draw' ? (
              <>
                <span><i className="swatch" style={{ background: 'var(--act-raise)' }} />{t(lang, 'pat')}</span>
                <span><i className="swatch" style={{ background: 'var(--act-call)' }} />{t(lang, 'drawN', { n: 1 })}</span>
                <span><i className="swatch" style={{ background: 'var(--act-fold)' }} />{t(lang, 'drawN', { n: 2 })}</span>
              </>
            ) : (
              <>
                <span><i className="swatch" style={{ background: 'var(--act-fold)' }} />{t(lang, 'legendFold')}</span>
                <span><i className="swatch" style={{ background: 'var(--act-call)' }} />{t(lang, 'legendCall')}</span>
                <span><i className="swatch" style={{ background: 'var(--act-raise)' }} />{t(lang, 'legendRaiseNL')}</span>
              </>
            )}
          </div>

          <div className="totals-bar">
            {view.actions.map((a, i) => (
              <span key={a.token} className={`total-chip act-${groupOf(a)}`}>
                <b>{actionLabel(lang, a)} {(view.totals[i] * 100).toFixed(1)}%</b>
              </span>
            ))}
          </div>

          <p className="hint">{t(lang, 'noteDraw')}</p>
        </section>
      )}
    </>
  )
}
