import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Card,
  type RazzActionLabel,
  type RazzGridResult,
  type RazzGridSpot,
  parseCard,
  razzBringInIndex,
} from './domain'
import type { SolveGridRequest, SolverResponse } from './worker/solverWorker'
import { type Lang, type MessageKey, t } from './i18n'

// グリッドの行/列順（Razz ランク。K が最弱 → 左上、A が最強 → 右下）
const RANK_ORDER = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] as const
const RANK_CHARS: Record<number, string> = {
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K',
}
const VALID_RANK_CHARS = 'A23456789TJQK'

// アクション → 履歴 1 文字（coerceRazzAction で局面の合法アクションに戻る表記）
const ACTION_TO_CHAR: Record<RazzActionLabel, string> = {
  fold: 'f', check: 'c', call: 'c', bet: 'r', complete: 'r', raise: 'r',
}
const ACTION_LABEL_KEY: Record<RazzActionLabel, MessageKey> = {
  fold: 'fold', check: 'check', call: 'call', bet: 'bet', complete: 'complete', raise: 'raise',
}

// アクションのグループ（凡例色と、セル内グラデーションの表示順）
function actionGroup(a: RazzActionLabel): 'call' | 'raise' | 'fold' {
  if (a === 'fold') return 'fold'
  if (a === 'check' || a === 'call') return 'call'
  return 'raise'
}
const GROUP_ORDER = { call: 0, raise: 1, fold: 2 } as const
const GROUP_COLOR = {
  fold: 'var(--act-fold)',
  call: 'var(--act-call)',
  raise: 'var(--act-raise)',
} as const

const PRESETS = [
  { key: 'presetFast', iterations: 3000 },
  { key: 'presetStandard', iterations: 10000 },
  { key: 'presetFine', iterations: 30000 },
] as const satisfies readonly { key: MessageKey; iterations: number }[]

interface StakesInput {
  ante: string
  bringIn: string
  smallBet: string
  bigBet: string
}

/**
 * ランク文字（1 席 1 枚）にスートを自動割り当てして Card 化する。
 * 同ランクは入力順に c→d→h→s（ブリングインの同ランク判定は後の席が優先になる）。
 */
function seatsFromRanks(rankChars: string[], lang: Lang): { seats?: { up: Card[] }[]; error?: string } {
  const used = new Map<string, number>()
  const seats: { up: Card[] }[] = []
  for (const [i, raw] of rankChars.entries()) {
    const ch = raw.trim().toUpperCase()
    if (ch.length !== 1 || !VALID_RANK_CHARS.includes(ch)) {
      return { error: t(lang, 'errRank', { n: i + 1 }) }
    }
    const n = used.get(ch) ?? 0
    if (n >= 4) return { error: t(lang, 'errTooMany', { rank: ch }) }
    used.set(ch, n + 1)
    seats.push({ up: [parseCard(ch + 'cdhs'[n])] })
  }
  return { seats }
}

type SolverState =
  | { status: 'idle' }
  | { status: 'solving'; progress: number }
  | { status: 'done'; result: RazzGridResult }
  | { status: 'error'; message: string }

/** レンジグリッド解析を Web Worker で実行するフック。再計算時は前の Worker を破棄する。 */
function useGridSolver() {
  const workerRef = useRef<Worker | null>(null)
  const idRef = useRef(0)
  const [state, setState] = useState<SolverState>({ status: 'idle' })

  const solve = useCallback((spot: RazzGridSpot, iterations: number) => {
    workerRef.current?.terminate()
    const worker = new Worker(new URL('./worker/solverWorker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker
    const id = ++idRef.current
    setState({ status: 'solving', progress: 0 })
    worker.onmessage = (e: MessageEvent<SolverResponse>) => {
      const msg = e.data
      if (msg.id !== id) return
      if (msg.type === 'progress') setState({ status: 'solving', progress: msg.done / msg.total })
      else if (msg.type === 'result') setState({ status: 'done', result: msg.result })
      else setState({ status: 'error', message: msg.message })
    }
    const req: SolveGridRequest = { id, spot, iterations }
    worker.postMessage(req)
  }, [])

  useEffect(() => () => workerRef.current?.terminate(), [])
  return { state, solve }
}

/** セル背景: アクション頻度を 縦縞（call → raise → fold の順）のグラデーションで表す。 */
function cellBackground(actions: readonly RazzActionLabel[], freqs: readonly number[]): string {
  const parts = actions
    .map((a, i) => ({ group: actionGroup(a), f: freqs[i] }))
    .sort((x, y) => GROUP_ORDER[x.group] - GROUP_ORDER[y.group])
  const stops: string[] = []
  let acc = 0
  for (const p of parts) {
    if (p.f <= 1e-4) continue
    stops.push(`${GROUP_COLOR[p.group]} ${(acc * 100).toFixed(1)}% ${((acc + p.f) * 100).toFixed(1)}%`)
    acc += p.f
  }
  if (stops.length === 0) return 'var(--panel2)'
  return `linear-gradient(to right, ${stops.join(', ')})`
}

export default function App() {
  const [lang, setLang] = useState<Lang>('ja')
  const [players, setPlayers] = useState(6)
  const [upRanks, setUpRanks] = useState<string[]>(['J', 'T', '7', '6', '8', 'K'])
  const [stakes, setStakes] = useState<StakesInput>({ ante: '1', bringIn: '2', smallBet: '4', bigBet: '8' })
  const [iterations, setIterations] = useState<number>(PRESETS[1].iterations)
  const [history, setHistory] = useState('ffffr')
  const [inputError, setInputError] = useState<string | null>(null)
  // 表示中の結果に対応する入力（結果ヘッダの Pos / カード表示に使う）
  const [solvedCtx, setSolvedCtx] = useState<{ upRanks: string[] } | null>(null)
  const { state, solve } = useGridSolver()

  const ranks = upRanks.slice(0, players)
  const parsed = seatsFromRanks(ranks, lang)
  const bringIn = parsed.seats ? razzBringInIndex(parsed.seats) : -1

  const runSolve = (hist: string) => {
    setInputError(null)
    const { seats, error } = seatsFromRanks(ranks, lang)
    if (!seats) {
      setInputError(error ?? '')
      return
    }
    const s = {
      ante: Number(stakes.ante),
      bringIn: Number(stakes.bringIn),
      smallBet: Number(stakes.smallBet),
      bigBet: Number(stakes.bigBet),
    }
    if (
      !Number.isFinite(s.ante) || !Number.isFinite(s.bringIn) ||
      !Number.isFinite(s.smallBet) || !Number.isFinite(s.bigBet) ||
      s.ante < 0 || s.bringIn <= 0 || s.smallBet <= 0 || s.bigBet <= 0 ||
      s.bringIn >= s.smallBet
    ) {
      setInputError(t(lang, 'errStakes'))
      return
    }
    setSolvedCtx({ upRanks: ranks })
    solve({ street: 3, seats, stakes: s, history: hist }, iterations)
  }

  const onAction = (action: RazzActionLabel) => {
    const next = history + ACTION_TO_CHAR[action]
    setHistory(next)
    runSolve(next)
  }

  const onPrevious = () => {
    if (history.length === 0) return
    const next = history.slice(0, -1)
    setHistory(next)
    runSolve(next)
  }

  const result = state.status === 'done' ? state.result : null
  const cellMap = new Map<string, { combos: number; frequencies: number[] }>()
  if (result) {
    for (const c of result.cells) cellMap.set(`${c.ranks[0]}-${c.ranks[1]}`, c)
  }

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t(lang, 'title')}</h1>
          <p className="subtitle">{t(lang, 'subtitle')}</p>
        </div>
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLang((l) => (l === 'ja' ? 'en' : 'ja'))}
        >
          {lang === 'ja' ? 'EN' : 'JA'}
        </button>
      </header>

      <section className="panel controls">
        <div className="row">
          <label className="field">
            <span>{t(lang, 'players')}</span>
            <select
              value={players}
              onChange={(e) => {
                const n = Number(e.target.value)
                setPlayers(n)
                setUpRanks((r) => {
                  const next = r.slice(0, n)
                  while (next.length < n) next.push('')
                  return next
                })
              }}
            >
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="positions">
          {ranks.map((r, i) => (
            <label key={i} className="field pos-field">
              <span>
                {t(lang, 'position', { n: i + 1 })}
                {i === bringIn && <em className="bi-badge">{t(lang, 'bringInBadge')}</em>}
              </span>
              <input
                className="rank-input"
                value={r}
                maxLength={1}
                inputMode="text"
                onChange={(e) => {
                  const v = e.target.value.toUpperCase()
                  setUpRanks((prev) => prev.map((x, j) => (j === i ? v : x)))
                }}
              />
            </label>
          ))}
        </div>

        <div className="row stakes-row">
          {(['ante', 'bringIn', 'smallBet', 'bigBet'] as const).map((k) => (
            <label key={k} className="field">
              <span>{t(lang, k === 'bringIn' ? 'bringInAmount' : k)}</span>
              <input
                className="num-input"
                value={stakes[k]}
                inputMode="decimal"
                onChange={(e) => setStakes((s) => ({ ...s, [k]: e.target.value }))}
              />
            </label>
          ))}
        </div>

        <div className="row">
          <label className="field grow">
            <span>{t(lang, 'history')}</span>
            <input
              className="history-input"
              value={history}
              placeholder="ffffr"
              onChange={(e) => setHistory(e.target.value.toLowerCase().replace(/[^fckxbpr]/g, ''))}
            />
          </label>
          <label className="field">
            <span>{t(lang, 'precision')}</span>
            <select value={iterations} onChange={(e) => setIterations(Number(e.target.value))}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.iterations}>{t(lang, p.key)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">{t(lang, 'historyHint')}</p>

        <button
          type="button"
          className="go-button"
          disabled={state.status === 'solving'}
          onClick={() => runSolve(history)}
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
        {inputError && <p className="error">{inputError}</p>}
        {state.status === 'error' && (
          <p className="error">
            {state.message}
            {history.length > 0 && (
              <button type="button" className="nav-button inline" onClick={onPrevious}>
                {t(lang, 'previous')}
              </button>
            )}
          </p>
        )}
      </section>

      {result && (
        <section className="panel result">
          <h2 className="actor-title">
            {t(lang, 'actorTitle', {
              n: result.actorIndex + 1,
              card: solvedCtx?.upRanks[result.actorIndex] ?? '',
            })}
          </h2>
          <p className="hint">
            {t(lang, result.horizon === 'river' ? 'horizonRiver' : 'horizonStreet')}
          </p>

          <div className="grid">
            {RANK_ORDER.map((hi, i) =>
              RANK_ORDER.slice(i).map((lo, dj) => {
                const j = i + dj
                const key = `${Math.min(lo, hi)}-${Math.max(lo, hi)}`
                const cell = cellMap.get(key)
                const label = `${RANK_CHARS[lo]}${RANK_CHARS[hi]}`
                if (!cell) return null
                const dead = cell.combos === 0
                const tooltip = dead
                  ? `${label}: ${t(lang, 'combos', { n: 0 })}`
                  : `${label}: ${result.actions
                      .map((a, k) => `${t(lang, ACTION_LABEL_KEY[a])} ${(cell.frequencies[k] * 100).toFixed(0)}%`)
                      .join(' / ')} (${t(lang, 'combos', { n: cell.combos })})`
                return (
                  <div
                    key={key}
                    className={dead ? 'cell dead' : 'cell'}
                    title={tooltip}
                    style={{
                      gridRow: i + 1,
                      gridColumn: j + 1,
                      background: dead ? undefined : cellBackground(result.actions, cell.frequencies),
                    }}
                  >
                    {label}
                  </div>
                )
              }),
            )}
          </div>

          <div className="legend">
            <span><i className="swatch" style={{ background: 'var(--act-fold)' }} />{t(lang, 'legendFold')}</span>
            <span><i className="swatch" style={{ background: 'var(--act-call)' }} />{t(lang, 'legendCall')}</span>
            <span><i className="swatch" style={{ background: 'var(--act-raise)' }} />{t(lang, 'legendRaise')}</span>
          </div>

          <div className="action-bar">
            <button
              type="button"
              className="nav-button"
              disabled={state.status === 'solving' || history.length === 0}
              onClick={onPrevious}
            >
              {t(lang, 'previous')}
            </button>
            {result.actions.map((a, i) => (
              <button
                key={a}
                type="button"
                className={`action-button act-${actionGroup(a)}`}
                disabled={state.status === 'solving'}
                onClick={() => onAction(a)}
              >
                {t(lang, ACTION_LABEL_KEY[a])} {(result.totals[i] * 100).toFixed(0)}%
              </button>
            ))}
          </div>

          <p className="hint">{t(lang, 'noteAbstraction')}</p>
        </section>
      )}
    </main>
  )
}
