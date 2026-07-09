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
import DrawView from './DrawView'
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

/**
 * 独立ソルブの結果を平均し（アンサンブル）、平均後に thresholding をかけて
 * 到達レンジ×コンボ加重の集計を再計算する。セル順・アクション順は全結果で同一。
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
  let totalCombos = 0
  for (const c of cells) {
    const w = c.combos * c.reach
    if (w <= 0) continue
    totalCombos += w
    c.frequencies.forEach((f, ai) => {
      totals[ai] += f * w
    })
  }
  return {
    ...base,
    cells,
    comboTotals: totals.slice(),
    totalCombos,
    totals: totalCombos > 0 ? totals.map((x) => x / totalCombos) : totals,
  }
}

type SolverState =
  | { status: 'idle' }
  | { status: 'solving'; progress: number; nodeIndex: number; nodeCount: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

interface TreeView {
  history: string
  result: RazzGridResult
}

/**
 * 遅延ツリーソルバー。ナビゲートしたノードを（初回のみ）Worker アンサンブルで
 * ソルブしてキャッシュし、訪問済みノードは即時表示する。各ノードのソルブは
 * 経路上の先行ノードの解いた頻度で各席の入口レンジを条件付けする
 * （＝レンジがアクションを経て内生的に絞られていく）。
 */
function useTreeSolver() {
  const cacheRef = useRef(new Map<string, RazzGridResult>())
  const cacheKeyRef = useRef('')
  const workersRef = useRef<Worker[]>([])
  const runIdRef = useRef(0)
  const [state, setState] = useState<SolverState>({ status: 'idle' })
  const [view, setView] = useState<TreeView | null>(null)

  const cancel = useCallback(() => {
    runIdRef.current++
    for (const w of workersRef.current) w.terminate()
    workersRef.current = []
  }, [])
  useEffect(() => cancel, [cancel])

  /** 1 ノードをアンサンブルでソルブする。キャンセル時は永遠に解決しない。 */
  const solveNode = useCallback(
    (
      req: Omit<SolveGridRequest, 'id' | 'threshold'>,
      workerCount: number,
      runId: number,
      onProgress: (p: number) => void,
    ) =>
      new Promise<RazzGridResult>((resolve, reject) => {
        const progresses = new Array<number>(workerCount).fill(0)
        const results = new Array<RazzGridResult | null>(workerCount).fill(null)
        for (let k = 0; k < workerCount; k++) {
          let worker: Worker
          try {
            worker = new SolverWorker()
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
            return
          }
          workersRef.current.push(worker)
          const slot = k
          worker.onmessage = (e: MessageEvent<SolverResponse>) => {
            if (runIdRef.current !== runId) return
            const msg = e.data
            if (msg.type === 'progress') {
              progresses[slot] = msg.done / msg.total
              onProgress(progresses.reduce((x, y) => x + y, 0) / workerCount)
            } else if (msg.type === 'result') {
              results[slot] = msg.result
              if (results.every((r) => r !== null)) {
                resolve(mergeGridResults(results as RazzGridResult[], DISPLAY_THRESHOLD))
              }
            } else {
              reject(new Error(msg.message))
            }
          }
          worker.postMessage({ id: runId, threshold: 0, ...req } satisfies SolveGridRequest)
        }
      }),
    [],
  )

  /**
   * 対象履歴のノードと、その経路上でアクティブな席が行動した先行ノードを
   * 順にソルブしてキャッシュし、対象ノードを表示する。
   */
  const navigate = useCallback(
    async (
      spotKey: string,
      makeSpot: (history: string) => RazzGridSpot,
      replayOf: (history: string) => RazzHistoryReplay,
      targetHistory: string,
      preset: (typeof PRESETS)[number],
    ) => {
      if (cacheKeyRef.current !== spotKey) {
        cacheRef.current.clear()
        cacheKeyRef.current = spotKey
        setView(null)
      }
      const cache = cacheRef.current
      const rep = replayOf(targetHistory)

      // 経路上の先行ノードの解から、席ごとの到達重み（自アクション頻度の積）を計算
      const reachAt = (history: string, replay: RazzHistoryReplay) => {
        const L: (number[] | null)[] = replay.folded.map(() => null)
        replay.steps.forEach((s, i) => {
          if (replay.folded[s.seatIndex]) return
          const pre = cache.get(history.slice(0, i))
          if (!pre) return
          const aIdx = pre.actions.indexOf(s.action)
          if (aIdx < 0) return
          const arr = (L[s.seatIndex] ??= new Array<number>(196).fill(1))
          for (const c of pre.cells) {
            arr[c.ranks[0] * 14 + c.ranks[1]] *= c.frequencies[aIdx]
          }
        })
        return L
      }

      // ソルブが必要なノード列（先行 → 対象の順）
      const nodes: string[] = []
      rep.steps.forEach((s, i) => {
        if (!rep.folded[s.seatIndex]) nodes.push(targetHistory.slice(0, i))
      })
      if (!rep.done) nodes.push(targetHistory)
      const todo = nodes.filter((h) => !cache.has(h))

      cancel()
      const runId = runIdRef.current
      try {
        for (const [i, h] of todo.entries()) {
          setState({ status: 'solving', progress: 0, nodeIndex: i + 1, nodeCount: todo.length })
          const hRep = replayOf(h)
          const L = reachAt(h, hRep)
          const actorReach = hRep.actorIndex >= 0 ? (L[hRep.actorIndex] ?? undefined) : undefined
          const seatPairWeights = L.map((w, si) => (si === hRep.actorIndex ? null : w))
          const result = await solveNode(
            {
              spot: makeSpot(h),
              iterations: preset.iterations,
              rootExact: preset.rootExact,
              seatPairWeights,
              actorReach,
            },
            preset.workers,
            runId,
            (p) =>
              setState({
                status: 'solving',
                progress: p,
                nodeIndex: i + 1,
                nodeCount: todo.length,
              }),
          )
          if (runIdRef.current !== runId) return
          cache.set(h, result)
        }
        setState({ status: 'ready' })
        const final = cache.get(targetHistory)
        setView(final ? { history: targetHistory, result: final } : null)
      } catch (err) {
        if (runIdRef.current !== runId) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    },
    [cancel, solveNode],
  )

  /** キャッシュ済みノードの即時表示（未ソルブなら false）。 */
  const showCached = useCallback((spotKey: string, history: string): boolean => {
    if (cacheKeyRef.current !== spotKey) return false
    const result = cacheRef.current.get(history)
    if (!result) return false
    setView({ history, result })
    return true
  }, [])

  const peek = useCallback(
    (spotKey: string, history: string): RazzGridResult | undefined =>
      cacheKeyRef.current === spotKey ? cacheRef.current.get(history) : undefined,
    [],
  )

  return { state, view, setView, navigate, showCached, peek, cancel }
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

function RazzView({ lang }: { lang: Lang }) {
  const [players, setPlayers] = useState(6)
  const [upRanks, setUpRanks] = useState<string[]>(['J', 'T', '7', '6', '8', 'K'])
  // 既定ステークス: 参照ソルバーとの校正でブリングインのポットオッズ約 4.6:1 の構造に合わせた
  const [stakes, setStakes] = useState<StakesInput>({ ante: '1', bringIn: '1.75', smallBet: '4', bigBet: '8' })
  const [presetIdx, setPresetIdx] = useState(1)
  const [history, setHistory] = useState('')
  const { state, view, navigate, showCached, peek } = useTreeSolver()

  const ranks = upRanks.slice(0, players)
  const parsed = seatsFromRanks(ranks, lang)
  const stakesNum = parseStakes(stakes)
  const spotKey = `${ranks.join('')}|${stakes.ante}|${stakes.bringIn}|${stakes.smallBet}|${stakes.bigBet}|${presetIdx}`

  // noLimp: リンプを許すと「強いハンドでリンプするトラップ均衡」に落ち、
  // コンプリートレンジの条件付けが実戦の慣行と乖離するため、UI では常に無効化する
  const makeSpot = (hist: string): RazzGridSpot => ({
    street: 3,
    seats: parsed.seats!,
    stakes: stakesNum!,
    history: hist,
    noLimp: true,
  })
  const replayOf = (hist: string) => replayRazzHistory(makeSpot(hist))

  // 履歴のリプレイ（手番・合法アクション・ポット）。入力が不完全な間は null。
  let replay: RazzHistoryReplay | null = null
  if (parsed.seats && stakesNum) {
    try {
      replay = replayOf(history)
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
    void navigate(spotKey, makeSpot, replayOf, hist, PRESETS[presetIdx])
  }

  /** アクションを 1 手進める。キャッシュ済みなら即時、未ソルブならソルブする。 */
  const pushAction = (action: RazzActionLabel) => {
    if (!parsed.seats || !stakesNum) return
    const next = history + ACTION_TO_CHAR[action]
    setHistory(next)
    try {
      const nr = replayOf(next)
      if (nr.done) return // ビルダーに終了表示（グリッドは前のまま）
    } catch {
      return
    }
    if (!showCached(spotKey, next)) runSolve(next)
  }

  const undo = () => {
    const next = history.slice(0, -1)
    setHistory(next)
    showCached(spotKey, next)
  }
  const reset = () => {
    setHistory('')
    showCached(spotKey, '')
  }

  const result = view?.result ?? null
  // 表示中の結果と現在の入力が一致しているか
  const inSync = view != null && view.history === history
  const cellMap = new Map<string, { combos: number; reach: number; frequencies: number[] }>()
  if (result) {
    for (const c of result.cells) cellMap.set(`${c.ranks[0]}-${c.ranks[1]}`, c)
  }

  const inputError = parsed.error ?? (stakesNum ? null : t(lang, 'errStakes'))
  const foldWin = replay?.done && replay.folded.filter((f) => !f).length === 1
  const solving = state.status === 'solving'

  // タイムラインチップ用: 各ステップのアクション頻度（キャッシュ済みノードから）
  const stepPct = (i: number): string | null => {
    if (!replay) return null
    const pre = peek(spotKey, history.slice(0, i))
    if (!pre) return null
    const aIdx = pre.actions.indexOf(replay.steps[i].action)
    if (aIdx < 0) return null
    return `${(pre.totals[aIdx] * 100).toFixed(0)}%`
  }

  return (
    <>
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
                  {stepPct(i) && <em className="step-pct">{stepPct(i)}</em>}
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
                {replay.legalActions.map((a) => {
                  const ai = inSync && result ? result.actions.indexOf(a) : -1
                  return (
                    <button
                      key={a}
                      type="button"
                      className={`action-button act-${actionGroup(a)}`}
                      disabled={solving}
                      onClick={() => pushAction(a)}
                    >
                      {t(lang, ACTION_LABEL_KEY[a])}
                      {ai >= 0 && result && ` ${(result.totals[ai] * 100).toFixed(0)}%`}
                    </button>
                  )
                })}
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
              <button type="button" className="nav-button" disabled={solving} onClick={undo}>
                {t(lang, 'undo')}
              </button>
              <button type="button" className="nav-button" disabled={solving} onClick={reset}>
                {t(lang, 'reset')}
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="go-button"
          disabled={solving || !replay || replay.done || inSync}
          onClick={() => runSolve(history)}
        >
          {solving
            ? t(lang, 'nodeProgress', {
                i: state.nodeIndex,
                k: state.nodeCount,
                pct: Math.round(state.progress * 100),
              })
            : t(lang, 'go')}
        </button>
        {solving && (
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${state.progress * 100}%` }} />
          </div>
        )}
        {inputError && <p className="error">{inputError}</p>}
        {state.status === 'error' && <p className="error">{state.message}</p>}
      </section>

      {result && view && (
        <section className="panel result">
          <h2 className="actor-title">
            {t(lang, 'actorTitle', {
              n: result.actorIndex + 1,
              card: ranks[result.actorIndex] ?? '',
            })}
          </h2>
          <p className="hint">
            {t(lang, result.horizon === 'river' ? 'horizonRiver' : 'horizonStreet')}
          </p>

          {!inSync && <p className="hint stale-note">{t(lang, 'staleResult')}</p>}

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
                      .join(' / ')} (${t(lang, 'combos', { n: (cell.combos * cell.reach).toFixed(1) })})`
                return (
                  <div
                    key={key}
                    className={dead ? 'cell dead' : 'cell'}
                    title={tooltip}
                    style={{
                      gridRow: i + 1,
                      gridColumn: j + 1,
                      background: dead ? undefined : cellBackground(result.actions, cell.frequencies),
                      opacity: dead ? undefined : 0.25 + 0.75 * cell.reach,
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

          <div className="totals-bar">
            {result.actions.map((a, i) => (
              <span key={a} className={`total-chip act-${actionGroup(a)}`}>
                <b>{t(lang, ACTION_LABEL_KEY[a])} {(result.totals[i] * 100).toFixed(1)}%</b>
                <small>{t(lang, 'combos', { n: result.comboTotals[i].toFixed(1) })}</small>
              </span>
            ))}
          </div>

          <p className="hint">
            {t(lang, result.rootExact ? 'noteExact' : 'noteAbstraction')}{' '}
            {t(lang, 'noteThreshold')} {t(lang, 'noteLazyTree')}
          </p>
        </section>
      )}
    </>
  )
}

export default function App() {
  const [lang, setLang] = useState<Lang>('ja')
  const [game, setGame] = useState<'razz' | 'draw'>('razz')
  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t(lang, game === 'razz' ? 'title' : 'titleDraw')}</h1>
          <p className="subtitle">{t(lang, game === 'razz' ? 'subtitle' : 'subtitleDraw')}</p>
        </div>
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLang((l) => (l === 'ja' ? 'en' : 'ja'))}
        >
          {lang === 'ja' ? 'EN' : 'JA'}
        </button>
      </header>
      <nav className="tabs">
        <button
          type="button"
          className={game === 'razz' ? 'tab active' : 'tab'}
          onClick={() => setGame('razz')}
        >
          {t(lang, 'tabRazz')}
        </button>
        <button
          type="button"
          className={game === 'draw' ? 'tab active' : 'tab'}
          onClick={() => setGame('draw')}
        >
          {t(lang, 'tabDraw')}
        </button>
      </nav>
      {game === 'razz' ? <RazzView lang={lang} /> : <DrawView lang={lang} />}
    </main>
  )
}
