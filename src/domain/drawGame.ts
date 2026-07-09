// NL 2-7 シングルドロー（deuce-to-seven single draw）のヘッズアップソルバー。
// razz のノウハウを再利用: MCCFR（external sampling + 二次加重平均）、バケット抽象化、
// 「フルゲームを 1 回ソルブして全ノードを照会」する GTO Wizard 風の閲覧。
//
// モデル（意図的な抽象化）:
// - ヘッズアップ限定（BTN/SB が 0.5bb、BB が 1bb をポスト）。HU なので均衡収束の
//   理論保証があり、ゲーム全体（プリドロー → ドロー → ポストドロー）を一括で解ける。
// - ベットサイズ抽象化: ポットベット/ポットレイズ + オールインの 2 種のみ
//   （BTN オープンは自然に 3bb になる）。ストリートごとの攻撃アクション上限 4。
// - ドローは 0〜2 枚。捨てる札は「ペアを崩し高い札から捨てて最良のローを残す」
//   決定的ルール（ストレート/フラッシュの引き目は無視する近似）。
//   OOP（BB）が先にドローし、IP はその枚数を見てから選べる（実ルール通り）。
// - ハンドはバケット抽象化: プリドローは（パットの強さ × 1枚ドローの質 × 2枚ドローの質）、
//   ポストドローは完成役のティア。情報集合は（フェーズ | 履歴 | バケット）。
//   履歴には双方のドロー枚数が含まれる（公開情報）。

import { type Card, makeDeck } from './cards'
import { mulberry32 } from './combinatorics'
import { lowballKey5, lowballRank, lowballValue5 } from './lowball'
import {
  type CfrGame,
  type CfrSolution,
  averageStrategy,
  runMccfr,
} from './razzCfr'

// ---- 公開型 -------------------------------------------------------------------

export interface DrawConfig {
  /** 有効スタック（bb 単位、両者同額）。 */
  stackBb: number
  /** ストリートあたりの攻撃アクション（ベット/レイズ/オールイン）上限。既定 4。 */
  raiseCap?: number
}

export type DrawActionKind = 'fold' | 'check' | 'call' | 'raise' | 'allin' | 'draw'

export interface DrawActionInfo {
  /** 履歴トークン（f/c/r/a または 0/1/2）。 */
  token: string
  kind: DrawActionKind
  /** ベット/レイズ/コール後のコミット額（bb）。fold/check/draw では undefined。 */
  toAmount?: number
  /** ドロー枚数（kind='draw' のみ）。 */
  count?: number
}

export interface DrawReplay {
  steps: { actor: number; token: string; info: DrawActionInfo }[]
  phase: 'pre' | 'draw' | 'post'
  actorIndex: number
  legal: DrawActionInfo[]
  /** 現在のポット（双方のコミット合計、bb）。 */
  pot: number
  toCall: number
  done: boolean
  foldWin: boolean
  invalidAt: number
}

export interface DrawSolveOptions {
  iterations?: number
  rng?: () => number
  onProgress?: (done: number, total: number) => void
  regretMatchingPlus?: boolean
  averagingExponent?: number
}

/** 一括ソルブした解のハンドル（Worker 内に保持して queryDrawTree で照会する）。 */
export interface DrawTreeSolution {
  sol: CfrSolution
  config: Required<DrawConfig>
  iterations: number
}

export interface DrawBucketRow {
  bucket: number
  /** バケットの内容（UI 表示用の構造化ラベル）。 */
  label: DrawBucketLabel
  /** 到達レンジ加重の出現確率（現在の手番プレイヤーのレンジ内シェア）。 */
  weight: number
  /** actions と同順の頻度。 */
  freqs: number[]
}

export interface DrawBucketLabel {
  kind: 'pre' | 'post'
  /** pre: パット詳細（'7s'〜'K/A'、'-'=役なし）。post: 完成役ティア。 */
  pat: string
  /** pre のみ: 1枚/2枚ドローの質（残り4枚/3枚の最高ランク）。 */
  draw1?: string
  /** pre のみ: 1枚ドローのキープにストレート/フラッシュの引き目危険がある。 */
  draw1Risky?: boolean
  draw2?: string
}

export interface DrawNode {
  done: boolean
  phase: 'pre' | 'draw' | 'post'
  actorIndex: number
  actions: DrawActionInfo[]
  /** 手番プレイヤーのレンジ（バケット行、weight 降順）。 */
  rows: DrawBucketRow[]
  /** 到達レンジ加重の全体頻度（actions と同順）。 */
  totals: number[]
  /** 履歴各ステップの（その席の到達レンジでの）アクション頻度。 */
  steps: { actor: number; token: string; info: DrawActionInfo; freq: number }[]
}

// ---- 2-7 バケット ---------------------------------------------------------------

/** パットの強さティア: 0=7ロー 1=8ロー 2=9ロー 3=Tロー 4=Jロー 5=Qロー 6=K/Aロー 7=役なし。 */
export function patTier(hand: readonly Card[]): number {
  const v = lowballValue5(hand)
  if (v[0] !== 0) return 7
  const top = v[1]
  if (top <= 7) return 0
  if (top <= 12) return top - 7 // 8→1 9→2 T→3 J→4 Q→5
  return 6
}

/**
 * パットの詳細ティア（スムーズ/ラフを 2 番目のランクで区別）:
 * 0=7s(75xxx) 1=7r(76xxx) 2=8s(2番目≤6) 3=8r 4=9s(≤6) 5=9r 6=Ts(≤7) 7=Tr
 * 8=J 9=Q 10=K/A 11=役なし。
 */
function patDetail(hand: readonly Card[]): number {
  const v = lowballValue5(hand)
  if (v[0] !== 0) return 11
  const top = v[1]
  const second = v[2]
  if (top === 7) return second <= 5 ? 0 : 1
  if (top === 8) return second <= 6 ? 2 : 3
  if (top === 9) return second <= 6 ? 4 : 5
  if (top === 10) return second <= 7 ? 6 : 7
  if (top === 11) return 8
  if (top === 12) return 9
  return 10
}

/**
 * n 枚残しの最良キープ（ペアを崩し、高い札から捨てる）。
 * 同ランク構成なら 4 フラッシュを避けるスートを選ぶ。
 * 返り値は残すカード。決定的（ドローの捨て札ルールとしても使う）。
 */
export function bestKeep(hand: readonly Card[], n: number): Card[] {
  let best: Card[] | null = null
  let bestScore: number[] | null = null
  const choose = (start: number, picked: number[]) => {
    if (picked.length === n) {
      const kept = picked.map((i) => hand[i])
      const ranks = kept.map(lowballRank).sort((a, b) => b - a)
      const dups = ranks.length - new Set(ranks).size
      const flush = n === 4 && new Set(kept.map((c) => c.suit)).size === 1 ? 1 : 0
      // 辞書式に小さいほど良い: ペアなし → 低い札 → （同ランクなら）4フラッシュ回避
      const score = [dups, ...ranks, flush]
      let better = bestScore === null
      if (bestScore) {
        for (let i = 0; i < score.length; i++) {
          if (score[i] !== bestScore[i]) {
            better = score[i] < bestScore[i]
            break
          }
        }
      }
      if (better) {
        bestScore = score
        best = kept
      }
      return
    }
    for (let i = start; i < 5; i++) choose(i + 1, [...picked, i])
  }
  choose(0, [])
  return best!
}

/** 4 枚キープの引き目危険: 1 枚でストレートが完成し得る、または 4 フラッシュ。 */
function keepDanger(kept: readonly Card[]): boolean {
  if (new Set(kept.map((c) => c.suit)).size === 1) return true
  const ranks = [...new Set(kept.map(lowballRank))].sort((a, b) => a - b)
  if (ranks.length !== 4) return false
  // 4 枚がある 5 連続窓に収まる（欠け 1 枚を引くとストレート）
  return ranks[3] - ranks[0] <= 4
}

/** n 枚キープの質ティア（重複なしで残せる最良の最高ランク）。 */
function keepTier(kept: readonly Card[], n: number): number {
  const ranks = kept.map(lowballRank)
  if (new Set(ranks).size < ranks.length) return n === 4 ? 4 : 3 // ペアが残る = 最悪
  const top = Math.max(...ranks)
  if (n === 4) return top <= 7 ? 0 : top === 8 ? 1 : top === 9 ? 2 : top === 10 ? 3 : 4
  return top <= 7 ? 0 : top === 8 ? 1 : top === 9 ? 2 : 3
}

/**
 * プリドローのバケット:
 * パット詳細(12) × [1枚ドロー質(5) × 引き目危険(2)](10) × 2枚ドロー質(4) = ≤480。
 * ブロッカー（2/7 の保有）は情報集合の分割コストに対する効果が薄いため含めない。
 */
export function preBucket(hand: readonly Card[]): number {
  const keep4 = bestKeep(hand, 4)
  const d1 = keepTier(keep4, 4) * 2 + (keepDanger(keep4) ? 1 : 0)
  const d2 = keepTier(bestKeep(hand, 3), 3)
  return (patDetail(hand) * 10 + d1) * 4 + d2
}

/** ポストドローのバケット（完成役ティア 0..13）。 */
export function postBucket(hand: readonly Card[]): number {
  const v = lowballValue5(hand)
  if (v[0] === 1) return 12
  if (v[0] >= 2) return 13
  const top = v[1]
  const second = v[2]
  if (top === 7) return second <= 5 ? 0 : 1
  if (top === 8) return second <= 6 ? 2 : 3
  if (top === 9) return second <= 6 ? 4 : 5
  if (top === 10) return second <= 7 ? 6 : 7
  if (top === 11) return 8
  if (top === 12) return 9
  if (top === 13) return 10
  return 11
}

const PRE_D1 = ['7', '8', '9', 'T', '-']
const PRE_D2 = ['7', '8', '9', '-']
const PAT = ['7s', '7r', '8s', '8r', '9s', '9r', 'Ts', 'Tr', 'J', 'Q', 'K/A', '-']
const POST = ['75432', '7', '8s', '8', '9s', '9', 'Ts', 'T', 'J', 'Q', 'K', 'A', 'pair', 'trash']

export function describeBucket(bucket: number, phase: 'pre' | 'draw' | 'post'): DrawBucketLabel {
  if (phase === 'post') {
    return { kind: 'post', pat: POST[bucket] ?? '?' }
  }
  const d2 = bucket % 4
  const d1 = Math.floor(bucket / 4) % 10
  const pat = Math.floor(bucket / 40)
  return {
    kind: 'pre',
    pat: PAT[pat] ?? '?',
    draw1: PRE_D1[Math.floor(d1 / 2)],
    draw1Risky: d1 % 2 === 1,
    draw2: PRE_D2[d2],
  }
}

// ---- ゲーム状態 -------------------------------------------------------------------

interface DrawDeal {
  /** シャッフル済み 52 枚。先頭 10 枚が配札、以降がドローの山。 */
  deck: Card[]
}

interface DrawState {
  phase: 'pre' | 'draw' | 'post'
  hist: string
  /** 各プレイヤーの現在の 5 枚（ドロー後は差し替え済み）。 */
  hands: [readonly Card[], readonly Card[]]
  committed: [number, number]
  pending: [boolean, boolean]
  raises: number
  drawCounts: [number, number]
  stubUsed: number
  actor: number
  folded: number // フォールドしたプレイヤー（-1 = なし）
  /** プリドローでオールインが成立し、ポストドローのベッティングがない。 */
  allin: boolean
  done: boolean
}

function pot(s: DrawState): number {
  return s.committed[0] + s.committed[1]
}

function legalDrawActions(s: DrawState, cfg: Required<DrawConfig>): DrawActionInfo[] {
  if (s.phase === 'draw') {
    return [0, 1, 2].map((k) => ({ token: String(k), kind: 'draw' as const, count: k }))
  }
  const a = s.actor
  const opp = 1 - a
  const stack = cfg.stackBb - s.committed[a]
  const toCall = Math.min(s.committed[opp] - s.committed[a], stack)
  const actions: DrawActionInfo[] = []
  if (toCall > 0) {
    actions.push({ token: 'f', kind: 'fold' })
    actions.push({ token: 'c', kind: 'call', toAmount: s.committed[a] + toCall })
  } else {
    actions.push({ token: 'c', kind: 'check' })
  }
  if (s.raises < cfg.raiseCap && stack > toCall) {
    // ポットレイズ: コール後のポットぶん上乗せ（オープンは自然に 3bb）
    const potAfterCall = 2 * (s.committed[a] + toCall)
    const raiseTo = Math.min(s.committed[a] + toCall + potAfterCall, cfg.stackBb)
    if (raiseTo < cfg.stackBb) {
      actions.push({ token: 'r', kind: 'raise', toAmount: raiseTo })
      actions.push({ token: 'a', kind: 'allin', toAmount: cfg.stackBb })
    } else {
      actions.push({ token: 'a', kind: 'allin', toAmount: cfg.stackBb })
    }
  }
  return actions
}

function applyDrawAction(
  s: DrawState,
  deal: DrawDeal,
  info: DrawActionInfo,
  cfg: Required<DrawConfig>,
): DrawState {
  const next: DrawState = {
    ...s,
    hands: [s.hands[0], s.hands[1]],
    committed: [...s.committed] as [number, number],
    pending: [...s.pending] as [boolean, boolean],
    drawCounts: [...s.drawCounts] as [number, number],
    hist: s.hist + info.token,
  }
  const a = s.actor
  const opp = 1 - a

  if (s.phase === 'draw') {
    const k = info.count!
    next.drawCounts[a] = k
    if (k > 0) {
      const kept = bestKeep(s.hands[a], 5 - k)
      const fresh = deal.deck.slice(10 + s.stubUsed, 10 + s.stubUsed + k)
      next.hands[a] = [...kept, ...fresh]
      next.stubUsed = s.stubUsed + k
    }
    if (a === 1) {
      next.actor = 0 // OOP(BB)=1 が先にドロー → IP(BTN)=0
      return next
    }
    // 両者ドロー完了
    if (s.allin) {
      next.done = true
      next.actor = -1
      return next
    }
    next.phase = 'post'
    next.hist += '/'
    next.actor = 1 // ポストドローは OOP(BB) から
    next.pending = [true, true]
    next.raises = 0
    return next
  }

  switch (info.kind) {
    case 'fold':
      next.folded = a
      next.done = true
      next.actor = -1
      return next
    case 'check':
      next.pending[a] = false
      break
    case 'call':
      next.committed[a] = info.toAmount!
      next.pending[a] = false
      break
    case 'raise':
    case 'allin':
      next.committed[a] = info.toAmount!
      next.raises = s.raises + 1
      next.pending[a] = false
      next.pending[opp] = true
      break
  }

  if (next.pending[opp]) {
    next.actor = opp
    return next
  }

  // ベッティング終了
  const someoneAllin = next.committed[0] >= cfg.stackBb || next.committed[1] >= cfg.stackBb
  if (s.phase === 'pre') {
    next.phase = 'draw'
    next.hist += '/'
    next.actor = 1 // OOP(BB) が先にドロー
    next.allin = someoneAllin
    next.drawCounts = [-1, -1]
    return next
  }
  next.done = true
  next.actor = -1
  return next
}

function drawUtility(s: DrawState, p: number): number {
  const opp = 1 - p
  if (s.folded === p) return -s.committed[p]
  if (s.folded === opp) return s.committed[opp]
  const kp = lowballKey5(s.hands[p])
  const ko = lowballKey5(s.hands[opp])
  if (kp < ko) return s.committed[opp]
  if (kp > ko) return -s.committed[p]
  return 0
}

function drawInfosetKey(s: DrawState): string {
  const a = s.actor
  const bucket = s.phase === 'post' ? postBucket(s.hands[a]) : preBucket(s.hands[a])
  return `${s.phase}|${s.hist}|${bucket}`
}

function makeDrawGame(cfg: Required<DrawConfig>): CfrGame<DrawDeal, DrawState> {
  const base = makeDeck()
  return {
    numPlayers: 2,
    sampleDeal: (rng) => {
      const deck = base.slice()
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
      }
      return { deck }
    },
    initialState: (deal) => ({
      phase: 'pre',
      hist: '',
      hands: [deal.deck.slice(0, 5), deal.deck.slice(5, 10)],
      committed: [0.5, 1],
      pending: [true, true],
      raises: 0,
      drawCounts: [-1, -1],
      stubUsed: 0,
      actor: 0,
      folded: -1,
      allin: false,
      done: false,
    }),
    isTerminal: (s) => s.done,
    utility: (s, _deal, p) => drawUtility(s, p),
    currentPlayer: (s) => s.actor,
    legalActions: (s) => legalDrawActions(s, cfg).map((x) => x.token),
    nextState: (s, deal, token) => {
      const info = legalDrawActions(s, cfg).find((x) => x.token === token)
      if (!info) throw new Error(`draw: illegal action "${token}"`)
      return applyDrawAction(s, deal, info, cfg)
    },
    infosetKey: (s) => drawInfosetKey(s),
  }
}

// ---- リプレイ（UI ビルダー用） -----------------------------------------------------

function tokenChars(tokens: string | readonly string[]): readonly string[] {
  if (typeof tokens === 'string') return [...tokens.replace(/[\s/,.|-]+/g, '')]
  return tokens
}

/** ダミー配札（リプレイでは手札を使わないが状態遷移に必要）。 */
const REPLAY_DEAL: DrawDeal = { deck: makeDeck() }

/** 履歴をリプレイして手番・合法アクション・ポットを返す（MCCFR なしの軽量ヘルパー）。 */
export function replayDrawHistory(
  config: DrawConfig,
  tokens: string | readonly string[],
): DrawReplay {
  const cfg: Required<DrawConfig> = { raiseCap: 4, ...config }
  if (cfg.stackBb <= 1) throw new Error('draw: stack must exceed 1bb')
  const game = makeDrawGame(cfg)
  let cur = game.initialState(REPLAY_DEAL)
  const steps: DrawReplay['steps'] = []
  let invalidAt = -1
  const chars = tokenChars(tokens)
  for (const [i, raw] of chars.entries()) {
    if (cur.done) {
      invalidAt = i
      break
    }
    const legal = legalDrawActions(cur, cfg)
    const info = legal.find((x) => x.token === raw)
    if (!info) {
      invalidAt = i
      break
    }
    steps.push({ actor: cur.actor, token: raw, info })
    cur = applyDrawAction(cur, REPLAY_DEAL, info, cfg)
  }
  return {
    steps,
    phase: cur.phase,
    actorIndex: cur.done ? -1 : cur.actor,
    legal: cur.done ? [] : legalDrawActions(cur, cfg),
    pot: pot(cur),
    toCall:
      cur.done || cur.phase === 'draw'
        ? 0
        : Math.max(0, cur.committed[1 - cur.actor] - cur.committed[cur.actor]),
    done: cur.done,
    foldWin: cur.folded >= 0,
    invalidAt,
  }
}

// ---- 一括ソルブ + ノード照会 -------------------------------------------------------

/**
 * NL 2-7 シングルドロー（HU）のゲーム全体を一括ソルブする。
 * HU なので均衡収束の理論保証があり、解いた後は queryDrawTree で任意のノードを
 * 即時照会できる。重い計算なので UI からは Web Worker 経由で呼ぶこと。
 */
export function solveDrawTree(config: DrawConfig, opts: DrawSolveOptions = {}): DrawTreeSolution {
  const cfg: Required<DrawConfig> = { raiseCap: 4, ...config }
  if (cfg.stackBb <= 1) throw new Error('draw: stack must exceed 1bb')
  const rng = opts.rng ?? mulberry32((Math.random() * 0xffffffff) >>> 0)
  const iterations = opts.iterations ?? 200000
  const sol = runMccfr(makeDrawGame(cfg), {
    iterations,
    rng,
    onProgress: opts.onProgress,
    regretMatchingPlus: opts.regretMatchingPlus,
    averagingExponent: opts.averagingExponent,
  })
  return { sol, config: cfg, iterations }
}

/**
 * 一括ソルブ済みの解から、指定履歴のノードを照会する（再計算なし・準即時）。
 * 手番プレイヤーのレンジをモンテカルロで再構成し（自分の過去アクション頻度で
 * 到達加重）、バケット行・全体頻度・履歴各ステップの頻度を返す。
 */
export function queryDrawTree(
  tree: DrawTreeSolution,
  tokens: string | readonly string[],
  opts: { samples?: number; rng?: () => number } = {},
): DrawNode {
  const cfg = tree.config
  const game = makeDrawGame(cfg)
  const samples = opts.samples ?? 20000
  const rng = opts.rng ?? mulberry32(0xc0ffee)
  const chars = tokenChars(tokens)

  // 履歴のノード列（betting/draw の状態と手番）を先に確定する
  const replay = replayDrawHistory(cfg, chars)
  if (replay.invalidAt >= 0) throw new Error('draw: illegal history')

  // 各プレイヤーについて独立に M 回サンプルし、履歴に沿って
  // （自分の判断ノードの頻度で）到達加重しながらハンドを進める。
  const playerOf = (stepIdx: number) => replay.steps[stepIdx].actor
  const stepFreqSum = new Array<number>(replay.steps.length).fill(0)
  const stepWeightSum = new Array<number>(replay.steps.length).fill(0)
  const rowWeight = new Map<number, number>()
  const actor = replay.actorIndex
  let totalsWeight = 0
  const finalLegal = replay.legal
  const totals = new Array<number>(finalLegal.length).fill(0)

  for (let p = 0; p < 2; p++) {
    // 相手のアクションは公開情報なのでリプレイで固定。自分の判断のみ重み付け。
    for (let m = 0; m < samples / 2; m++) {
      const deal = game.sampleDeal(rng)
      let cur = game.initialState(deal)
      let w = 1
      for (let i = 0; i < chars.length; i++) {
        const legal = legalDrawActions(cur, cfg)
        const info = legal.find((x) => x.token === chars[i])!
        if (cur.actor === p && cur.phase !== 'draw') {
          const freqs = averageStrategy(tree.sol, drawInfosetKey(cur), legal.length)
          const aIdx = legal.findIndex((x) => x.token === chars[i])
          if (playerOf(i) === p) {
            stepFreqSum[i] += w * freqs[aIdx]
            stepWeightSum[i] += w
          }
          w *= freqs[aIdx]
        } else if (cur.actor === p && cur.phase === 'draw' && playerOf(i) === p) {
          const freqs = averageStrategy(tree.sol, drawInfosetKey(cur), legal.length)
          const aIdx = legal.findIndex((x) => x.token === chars[i])
          stepFreqSum[i] += w * freqs[aIdx]
          stepWeightSum[i] += w
          w *= freqs[aIdx]
        }
        cur = applyDrawAction(cur, deal, info, cfg)
      }
      if (w <= 0) continue
      if (!replay.done && p === actor && cur.actor === actor) {
        const legal = legalDrawActions(cur, cfg)
        const bucket =
          cur.phase === 'post' ? postBucket(cur.hands[actor]) : preBucket(cur.hands[actor])
        const freqs = averageStrategy(tree.sol, drawInfosetKey(cur), legal.length)
        rowWeight.set(bucket, (rowWeight.get(bucket) ?? 0) + w)
        totalsWeight += w
        for (let ai = 0; ai < legal.length; ai++) totals[ai] += w * freqs[ai]
      }
    }
  }

  // バケット行（weight 降順）。hist 文字列は '/' 区切り込みでリプレイから再構成する
  const hist = histOf(cfg, chars)
  const rows: DrawBucketRow[] = [...rowWeight.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, weight]) => ({
      bucket,
      label: describeBucket(bucket, replay.phase),
      weight: totalsWeight > 0 ? weight / totalsWeight : 0,
      freqs: averageStrategy(tree.sol, `${replay.phase}|${hist}|${bucket}`, finalLegal.length),
    }))

  return {
    done: replay.done,
    phase: replay.phase,
    actorIndex: replay.actorIndex,
    actions: finalLegal,
    rows,
    totals: totalsWeight > 0 ? totals.map((x) => x / totalsWeight) : totals,
    steps: replay.steps.map((s, i) => ({
      ...s,
      freq: stepWeightSum[i] > 0 ? stepFreqSum[i] / stepWeightSum[i] : 0,
    })),
  }
}

/** 履歴トークン列から canonical hist 文字列（'/' 区切り込み）を再構成する。 */
function histOf(cfg: Required<DrawConfig>, chars: readonly string[]): string {
  const game = makeDrawGame(cfg)
  let cur = game.initialState(REPLAY_DEAL)
  for (const c of chars) {
    const info = legalDrawActions(cur, cfg).find((x) => x.token === c)
    if (!info) break
    cur = applyDrawAction(cur, REPLAY_DEAL, info, cfg)
  }
  return cur.hist
}
