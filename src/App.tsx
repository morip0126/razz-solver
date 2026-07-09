import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Card,
  type RazzActionLabel,
  type RazzGridResult,
  type RazzGridSpot,
  type RazzHistoryReplay,
  parseCard,
  replayRazzHistory,
  thresholdStrategy,
} from './domain'
// ?worker&inline: Worker コードを本体バンドルへ埋め込む（単一ファイル配布・
// GitHub Pages 以外の静的ホスティングでもパス解決不要にするため）
import SolverWorker from './worker/solverWorker?worker&inline'
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
  { key: 'presetFast', iterations: 3000, rootExact: false, workers: 1 },
  { key: 'presetStandard', iterations: 10000, rootExact: false, workers: 1 },
  { key: 'presetFine', iterations: 30000, rootExact: false, workers: 1 },
  // 手番ストリートをバケットではなく正確な91ランクペアで解く。境界ハンドの
  // 収束ノイズを抑えるため、独立した Worker 3 本を並列実行して平均する
  // （壁時計はほぼ 1 本分、分散は 1/√3。実効 240k 反復相当）。
  { key: 'presetExact', iterations: 80000, rootExact: true, workers: 3 },
] as const satisfies readonly {
  key: MessageKey
  iterations: number
  rootExact: boolean
  workers: number
}[]

// 表示 thresholding: この頻度未満のアクションは収束ノイズとみなして 0 に丸める
// （Ganzfried & Sandholm 2012。docs/solver-theory.md §4.3）
const DISPLAY_THRESHOLD = 0.05

interface StakesInput {
  ante: string
  bringIn: string
  smallBet: string
  bigBet: string
}

interface StakesNum {
  ante: number
  bringIn: number
  smallBet: number
  bigBet: number
}

function parseStakes(s: StakesInput): StakesNum | null {
  const v: StakesNum = {
    ante: Number(s.ante),
    bringIn: Number(s.bringIn),
    smallBet: Number(s.smallBet),
    bigBet: Number(s.bigBet),
  }
  if (
    !Number.isFinite(v.ante) || !Number.isFinite(v.bringIn) ||
    !Number.isFinite(v.smallBet) || !Number.isFinite(v.bigBet) ||
    v.ante < 0 || v.bringIn <= 0 || v.smallBet <= 0 || v.bigBet <= 0 ||
    v.bringIn >= v.smallBet
  ) {
    return null
  }
  return v
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

/**
 * 独立ソルブの結果を平均し（アンサンブル）、平均後に thresholding をかけて
 * 全体頻度を再集計する。セル順・アクション順は全結果で同一。
 */
function mergeGridResults(results: RazzGridResult[], threshold: number): RazzGridResult {
  const base = results[0]
  const cells = base.cells.map((cell, ci) => ({
    ...cell,
    frequencies: thresholdStrategy(
      cell.frequencies.map(
        (_, ai) => results.reduce((x, r) => x + r.cells[ci].frequencies[ai], 0) / results.length,
      ),
      threshold,
    ),
  }))
  const totals = base.totals.map(() => 0)
  let combos = 0
  for (const c of cells) {
    if (c.combos === 0) continue
    combos += c.combos
    c.frequencies.forEach((f, ai) => {
      totals[ai] += f * c.combos
    })
  }
  return {
    ...base,
    cells,
    totals: combos > 0 ? totals.map((x) => x / combos) : totals,
  }
}

/**
 * レンジグリッド解析を Web Worker で実行するフック。workers > 1 なら独立した
 * ソルブを並列実行して平均する（マルチコア活用。分散が 1/√N になる）。
 * 再計算時は前の Worker 群を破棄する。
 */
function useGridSolver() {
  const workersRef = useRef<Worker[]>([])
  const idRef = useRef(0)
  const [state, setState] = useState<SolverState>({ status: 'idle' })

  const solve = useCallback(
    (spot: RazzGridSpot, iterations: number, rootExact: boolean, workerCount: number) => {
      for (const w of workersRef.current) w.terminate()
      workersRef.current = []
      const id = ++idRef.current
      const progresses = new Array<number>(workerCount).fill(0)
      const results = new Array<RazzGridResult | null>(workerCount).fill(null)
      setState({ status: 'solving', progress: 0 })
      for (let k = 0; k < workerCount; k++) {
        let worker: Worker
        try {
          worker = new SolverWorker()
        } catch (err) {
          // Worker が使えない環境（CSP 等）ではエラー表示に落とす
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
          return
        }
        workersRef.current.push(worker)
        const slot = k
        worker.onmessage = (e: MessageEvent<SolverResponse>) => {
          const msg = e.data
          if (msg.id !== id) return
          if (msg.type === 'progress') {
            progresses[slot] = msg.done / msg.total
            setState({
              status: 'solving',
              progress: progresses.reduce((x, y) => x + y, 0) / workerCount,
            })
          } else if (msg.type === 'result') {
            results[slot] = msg.result
            if (results.every((r) => r !== null)) {
              setState({
                status: 'done',
                result: mergeGridResults(results as RazzGridResult[], DISPLAY_THRESHOLD),
              })
            }
          } else {
            for (const w of workersRef.current) w.terminate()
            setState({ status: 'error', message: msg.message })
          }
        }
        // thresholding はアンサンブル平均の後に UI 側でかける（Worker は生の頻度を返す）
        const req: SolveGridRequest = { id, spot, iterations, rootExact, threshold: 0 }
        worker.postMessage(req)
      }
    },
    [],
  )

  useEffect(
    () => () => {
      for (const w of workersRef.current) w.terminate()
    },
    [],
  )
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
  // 既定ステークス: 参照ソルバーとの校正でブリングインのポットオッズ約 4.6:1 の構造に合わせた
  const [stakes, setStakes] = useState<StakesInput>({ ante: '1', bringIn: '1.75', smallBet: '4', bigBet: '8' })
  const [presetIdx, setPresetIdx] = useState(1)
  const [history, setHistory] = useState('')
  // 表示中の結果に対応する入力（結果ヘッダ表示と、頻度ボタンの同期判定に使う）
  const [solvedCtx, setSolvedCtx] = useState<{ upRanks: string[]; history: string } | null>(null)
  const { state, solve } = useGridSolver()

  const ranks = upRanks.slice(0, players)
  const parsed = seatsFromRanks(ranks, lang)
  const stakesNum = parseStakes(stakes)

  // 履歴のリプレイ（手番・合法アクション・ポット）。入力が不完全な間は null。
  let replay: RazzHistoryReplay | null = null
  if (parsed.seats && stakesNum) {
    try {
      replay = replayRazzHistory({ street: 3, seats: parsed.seats, stakes: stakesNum, history })
    } catch {
      replay = null
    }
  }

  // アップカード変更などで履歴が不正になったら、有効な部分まで切り詰める
  useEffect(() => {
    if (replay && replay.invalidAt >= 0) {
      const valid = replay.steps.length
      setHistory((h) => h.slice(0, valid))
    }
  })

  const runSolve = (hist: string) => {
    if (!parsed.seats || !stakesNum) return
    const preset = PRESETS[presetIdx]
    setSolvedCtx({ upRanks: ranks, history: hist })
    solve(
      { street: 3, seats: parsed.seats, stakes: stakesNum, history: hist },
      preset.iterations,
      preset.rootExact,
      preset.workers,
    )
  }

  /** アクションを 1 手進める。fromResult=true（頻度ボタン）は続きも自動計算する。 */
  const pushAction = (action: RazzActionLabel, fromResult: boolean) => {
    if (!parsed.seats || !stakesNum) return
    const next = history + ACTION_TO_CHAR[action]
    setHistory(next)
    if (!fromResult) return
    try {
      const nr = replayRazzHistory({ street: 3, seats: parsed.seats, stakes: stakesNum, history: next })
      if (!nr.done) runSolve(next)
    } catch {
      // 入力が壊れている場合は何もしない（ビルダー側にエラー表示が出る）
    }
  }

  const undo = () => setHistory((h) => h.slice(0, -1))
  const reset = () => setHistory('')

  const onPrevious = () => {
    if (history.length === 0) return
    const next = history.slice(0, -1)
    setHistory(next)
    runSolve(next)
  }

  const result = state.status === 'done' ? state.result : null
  // 表示中の結果と現在の入力が一致しているか（不一致なら頻度ボタンを無効化）
  const inSync =
    solvedCtx != null &&
    solvedCtx.history === history &&
    solvedCtx.upRanks.join() === ranks.join()
  const cellMap = new Map<string, { combos: number; frequencies: number[] }>()
  if (result) {
    for (const c of result.cells) cellMap.set(`${c.ranks[0]}-${c.ranks[1]}`, c)
  }

  const inputError = parsed.error ?? (stakesNum ? null : t(lang, 'errStakes'))
  const foldWin = replay?.done && replay.folded.filter((f) => !f).length === 1

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
                setHistory('')
              }}
            >
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>{n}</option>
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

        <div className="positions">
          {ranks.map((r, i) => {
            const classes = ['field', 'pos-field']
            if (replay?.folded[i]) classes.push('folded')
            if (replay?.actorIndex === i) classes.push('acting')
            return (
              <label key={i} className={classes.join(' ')}>
                <span>
                  {t(lang, 'position', { n: i + 1 })}
                  {i === replay?.bringInIndex && <em className="bi-badge">{t(lang, 'bringInBadge')}</em>}
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
            )
          })}
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

        <div className="action-builder">
          <p className="section-label">{t(lang, 'actionsLabel')}</p>

          {replay && replay.steps.length > 0 && (
            <div className="timeline">
              {replay.steps.map((s, i) => (
                <span key={i} className={`step-chip step-${actionGroup(s.action)}`}>
                  <b>{t(lang, 'position', { n: s.seatIndex + 1 })}</b>
                  {' '}{ranks[s.seatIndex]}{' '}
                  {t(lang, ACTION_LABEL_KEY[s.action])}
                </span>
              ))}
            </div>
          )}

          {replay && !replay.done && (
            <>
              <p className="next-line">
                {t(lang, 'nextToAct', {
                  n: replay.actorIndex + 1,
                  card: ranks[replay.actorIndex],
                })}
                <span className="pot-info">
                  {t(lang, 'potLabel', { n: replay.pot })}
                  {replay.toCall > 0 && <> ・ {t(lang, 'toCallLabel', { n: replay.toCall })}</>}
                </span>
              </p>
              <div className="builder-buttons">
                {replay.legalActions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`action-button act-${actionGroup(a)}`}
                    onClick={() => pushAction(a, false)}
                  >
                    {t(lang, ACTION_LABEL_KEY[a])}
                  </button>
                ))}
              </div>
            </>
          )}

          {replay?.done && (
            <p className="hint done-note">
              {t(lang, foldWin ? 'handOver' : 'streetClosed')}
            </p>
          )}

          {history.length > 0 && (
            <div className="builder-nav">
              <button type="button" className="nav-button" onClick={undo}>
                {t(lang, 'undo')}
              </button>
              <button type="button" className="nav-button" onClick={reset}>
                {t(lang, 'reset')}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="go-button"
          disabled={state.status === 'solving' || !replay || replay.done}
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
        {state.status === 'error' && <p className="error">{state.message}</p>}
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

          {!inSync && <p className="hint stale-note">{t(lang, 'staleResult')}</p>}

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
                disabled={state.status === 'solving' || !inSync}
                onClick={() => pushAction(a, true)}
              >
                {t(lang, ACTION_LABEL_KEY[a])} {(result.totals[i] * 100).toFixed(0)}%
              </button>
            ))}
          </div>

          <p className="hint">
            {t(lang, result.rootExact ? 'noteExact' : 'noteAbstraction')}{' '}
            {t(lang, 'noteThreshold')}
          </p>
        </section>
      )}
    </main>
  )
}
