// Razz の固定リミット・スポットソルバー。
// 与えられたスポット（各シートのアップカード + Hero の伏せ札 + 現在ストリートの
// アクション履歴 + ステークス）から MCCFR で戦略を計算し、GTO Wizard 風の
// 「アクションごとの頻度と EV」を返す。
//
// 抽象化と制約（意図的な近似。結果を読むときの前提）:
// - ヘッズアップ（ルート時点でアクティブ2人）はリバー（7th）までのフルツリーを解く。
//   3人以上は現在ストリートのベッティングのみを解き、その後はチェックダウンとして
//   ショーダウンを評価する（将来ストリートのベッティングは EV に乗らない）。
//   また 3人以上の CFR は均衡保証のない近似解。
// - 情報集合はハンドを「バケット」（メイドローの強さ × 8以下の枚数）に落として
//   抽象化する。公開情報は相手ボードの粗いティアで表す。
// - 学習時は Hero の伏せ札もレンジからサンプルする（公開情報ベースの均衡計算）。
//   Hero の実ハンドの EV は、学習後に実ハンドを固定したロールアウトで推定する。
// - スタック無限（オールインなし）の固定リミットを仮定。

import { type Card, remainingDeck } from './cards'
import { mulberry32 } from './combinatorics'
import {
  type RazzStreet,
  razzBestKey,
  razzBoardKey,
  razzRank,
  razzUpCount,
} from './razz'
import {
  DEFAULT_RAZZ_RANGE,
  type RazzRangeModel,
  drawUniform,
  rankWeightTable,
  sampleHiddenCards,
} from './razzRange'
import {
  type CfrGame,
  averageStrategy,
  estimateActionValues,
  runMccfr,
} from './razzCfr'
import {
  type RazzEquityInput,
  type RazzSeatInput,
  estimateRazzEquity,
  validateRazzInput,
  validateRazzPublic,
} from './razzEquity'

// ---- 公開型 -------------------------------------------------------------------

export interface RazzStakes {
  ante: number
  bringIn: number
  smallBet: number
  bigBet: number
  /** ストリートあたりの攻撃的アクション（ベット/コンプリート/レイズ）上限。既定 4。 */
  raiseCap?: number
}

export type RazzActionLabel = 'fold' | 'check' | 'call' | 'bet' | 'complete' | 'raise'

export interface RazzSpot {
  street: RazzStreet
  /** 現在ストリート開始時点でアクティブな全プレイヤー（Hero 含む、シート順）。 */
  seats: RazzSeatInput[]
  heroIndex: number
  heroDown: Card[]
  /** フォールドで見えたカードなどのデッドカード。 */
  dead?: Card[]
  stakes: RazzStakes
  /**
   * 現在ストリート開始時点のポット（アンティ・前ストリートのベット込み、
   * ブリングインは含めない）。3rd street では省略時 ante × 人数。4th 以降は必須。
   */
  pot?: number
  /** 現在ストリートで Hero の手番までに起きたアクション（行動順）。 */
  actionsSoFar?: RazzActionLabel[]
  /** 3rd street のブリングイン席。省略時は最高位のアップカードから自動判定。 */
  bringInIndex?: number
}

export interface RazzActionAdvice {
  action: RazzActionLabel
  /** 平均戦略でこのアクションを取る頻度。 */
  frequency: number
  /** このアクションの EV（チップ単位、現時点からの増減。fold = 0）。 */
  ev: number
}

export interface RazzSpotResult {
  actions: RazzActionAdvice[]
  /** Hero のショーダウンエクイティ（ポット取り分）。 */
  equity: number
  /** 'river' = 7th までのフルツリー（HU）、'street' = 現在ストリートのみ（マルチウェイ）。 */
  horizon: 'river' | 'street'
  iterations: number
  evalSamples: number
}

export interface RazzSolveOptions {
  /** MCCFR の反復回数。既定 30000。 */
  iterations?: number
  /** EV 推定ロールアウトのサンプル数。既定 6000。 */
  evalSamples?: number
  /** エクイティ推定の反復回数。既定 4000。 */
  equityIters?: number
  rng?: () => number
  range?: RazzRangeModel
  /** MCCFR 学習の進捗通知（約1%刻み）。Worker から UI へ返す用。 */
  onProgress?: (done: number, total: number) => void
}

/**
 * レンジグリッド解析（GTO Wizard 風）のスポット。Hero の実ハンドは固定せず、
 * 履歴の後に手番となるプレイヤーの「伏せ札2枚の全ランクペア」の戦略を返す。
 */
export interface RazzGridSpot {
  street: RazzStreet
  /** 現在ストリート開始時点でアクティブな全プレイヤー（シート順）。 */
  seats: RazzSeatInput[]
  /** フォールドで見えたカードなどのデッドカード。 */
  dead?: Card[]
  stakes: RazzStakes
  /** 現在ストリート開始時点のポット。3rd street では省略時 ante × 人数。 */
  pot?: number
  /**
   * 現在ストリートのアクション履歴（行動順）。"ffffr" のような文字列、
   * またはラベル / 1文字表記（f=fold, k/x=check, c=call/check, b/p/r=bet/complete/raise）の配列。
   */
  history?: string | readonly string[]
  /** 3rd street のブリングイン席。省略時は最高位のアップカードから自動判定。 */
  bringInIndex?: number
}

export interface RazzGridCell {
  /** 伏せ札2枚の Razz ランク（1=A .. 13=K）、昇順。 */
  ranks: [number, number]
  /** 見えているカードを除いた残りデッキから作れるコンボ数。 */
  combos: number
  /** actions と同順の頻度（平均戦略）。 */
  frequencies: number[]
}

export interface RazzGridResult {
  /** 履歴の後に手番となる席。このプレイヤーの戦略グリッド。 */
  actorIndex: number
  actions: RazzActionLabel[]
  /** 全 91 ランクペア（A..K の組み合わせ + ペア）。 */
  cells: RazzGridCell[]
  /** コンボ数で加重した全体頻度（actions と同順）。 */
  totals: number[]
  horizon: 'river' | 'street'
  iterations: number
}

// ---- 内部状態 -------------------------------------------------------------------

interface BetState {
  street: number
  /** 前ストリートまでにポットに入ったチップ（現在ストリートの contrib は含まない）。 */
  pot: number
  contrib: number[]
  /** ルート（Hero の判断時点）以降に各シートが投入したチップ。 */
  afterRoot: number[]
  folded: boolean[]
  pending: boolean[]
  betLevel: number
  raises: number
  actor: number
  done: boolean
  /** フォールドで決着したときの勝者。ショーダウンは -1。 */
  winner: number
  hist: string
}

interface RazzDeal {
  /** 各シート 7 枚: [down1, down2, up1..up4, down3] の順。 */
  hands: Card[][]
  showdownKey: number[]
  /** [seat][street-3] のハンドバケット。 */
  buckets: number[][]
  /** [seat][street-3] のボードティア。 */
  boardTiers: number[][]
}

interface SpotCtx {
  seats: RazzSeatInput[]
  n: number
  heroIndex: number
  heroDown: Card[]
  stakes: Required<RazzStakes>
  horizon: number
  root: BetState
  range: RazzRangeModel
  /** 学習用プール（Hero の伏せ札もサンプル対象に含める）。 */
  trainPool: Card[]
  /** 評価用プール（Hero の伏せ札を除く）。 */
  evalPool: Card[]
  /** シートごとの伏せ札重みテーブル（rankWeightTable で事前計算）。 */
  seatWeights: Float64Array[]
}

const ACTION_CHAR: Record<RazzActionLabel, string> = {
  fold: 'f',
  check: 'k',
  call: 'c',
  bet: 'b',
  complete: 'p',
  raise: 'r',
}

// 1文字表記 → 候補ラベル（合法な最初のものを採用）。c はベットに直面していなければ
// check、b/p/r はその局面の攻撃的アクション（bet / complete / raise）に解決する。
const ACTION_ALIASES: Record<string, readonly RazzActionLabel[]> = {
  f: ['fold'],
  k: ['check'],
  x: ['check'],
  c: ['call', 'check'],
  b: ['bet', 'complete', 'raise'],
  p: ['complete', 'bet', 'raise'],
  r: ['raise', 'complete', 'bet'],
}

/**
 * アクション表記（ラベルまたは 1 文字）を合法アクションへ解決する。
 * 解決できなければ null。
 */
export function coerceRazzAction(
  input: string,
  legal: readonly RazzActionLabel[],
): RazzActionLabel | null {
  if ((legal as readonly string[]).includes(input)) return input as RazzActionLabel
  const candidates = ACTION_ALIASES[input.toLowerCase()]
  if (!candidates) return null
  for (const a of candidates) if (legal.includes(a)) return a
  return null
}

function cloneState(s: BetState): BetState {
  return {
    ...s,
    contrib: [...s.contrib],
    afterRoot: [...s.afterRoot],
    folded: [...s.folded],
    pending: [...s.pending],
  }
}

function streetBet(street: number, stakes: Required<RazzStakes>): number {
  return street <= 4 ? stakes.smallBet : stakes.bigBet
}

function activeCount(s: BetState): number {
  let n = 0
  for (const f of s.folded) if (!f) n++
  return n
}

// ---- 抽象化（バケット / ボードティア） ------------------------------------------

/**
 * ハンドバケット: メイドローの強さティア × 8以下の異なるランク数。
 * ティア: 0=5ロー以下 1=6ロー 2=7ロー 3=8ロー 4=9/10ロー 5=それ以上のメイド
 *         6=未完成（ペアなし） 7=未完成（ペアあり）
 */
export function razzHandBucket(cards: readonly Card[]): number {
  const distinct = [...new Set(cards.map(razzRank))].sort((a, b) => a - b)
  const lowCount = Math.min(7, distinct.filter((r) => r <= 8).length)
  let tier: number
  if (distinct.length >= 5) {
    const high = distinct[4]
    tier = high <= 5 ? 0 : high === 6 ? 1 : high === 7 ? 2 : high === 8 ? 3 : high <= 10 ? 4 : 5
  } else {
    tier = cards.length > distinct.length ? 7 : 6
  }
  return tier * 8 + lowCount
}

/** ボードティア（相手のアップカードの粗い分類。5=ペアボード）。 */
export function razzBoardTier(up: readonly Card[]): number {
  const ranks = up.map(razzRank)
  if (new Set(ranks).size < ranks.length) return 5
  const high = Math.max(...ranks)
  return high <= 5 ? 0 : high <= 7 ? 1 : high === 8 ? 2 : high <= 10 ? 3 : 4
}

// ---- アクション順 -------------------------------------------------------------

/** 3rd street のブリングイン席（最高位カード。同ランクはスート c<d<h<s で高い方）。 */
export function razzBringInIndex(seats: readonly RazzSeatInput[]): number {
  let best = 0
  let bestKey = -1
  for (const [i, seat] of seats.entries()) {
    const c = seat.up[0]
    const key = razzRank(c) * 4 + ['c', 'd', 'h', 's'].indexOf(c.suit)
    if (key > bestKey) {
      bestKey = key
      best = i
    }
  }
  return best
}

/** 4th street 以降の先頭アクター（最も低いボード。同値は席順が早い方）。 */
function firstToActFromUps(ups: readonly Card[][], folded: readonly boolean[]): number {
  let best = -1
  let bestKey = Infinity
  for (let i = 0; i < ups.length; i++) {
    if (folded[i]) continue
    const key = razzBoardKey(ups[i])
    if (key < bestKey) {
      bestKey = key
      best = i
    }
  }
  return best
}

function upsAtStreet(deal: RazzDeal, street: number): Card[][] {
  const count = razzUpCount(street as RazzStreet)
  return deal.hands.map((hand) => hand.slice(2, 2 + count))
}

// ---- 状態遷移 -------------------------------------------------------------------

function legalActionsOf(state: BetState, ctx: SpotCtx): RazzActionLabel[] {
  const toCall = state.betLevel - state.contrib[state.actor]
  const actions: RazzActionLabel[] = toCall > 0 ? ['fold', 'call'] : ['check']
  if (state.raises < ctx.stakes.raiseCap) {
    actions.push(
      state.betLevel === 0
        ? 'bet'
        : state.street === 3 && state.betLevel === ctx.stakes.bringIn
          ? 'complete'
          : 'raise',
    )
  }
  return actions
}

function raisedLevel(state: BetState, ctx: SpotCtx): number {
  const bet = streetBet(state.street, ctx.stakes)
  if (state.betLevel === 0) return bet
  if (state.street === 3 && state.betLevel === ctx.stakes.bringIn) return ctx.stakes.smallBet
  return state.betLevel + bet
}

/**
 * アクションを適用して次状態を返す（非破壊）。
 * ストリートが閉じて次ストリートへ進むときはアクション順の決定に deal が必要。
 * deal=null（リプレイ時）でストリートが閉じる入力はエラー。
 */
function applyAction(
  state: BetState,
  ctx: SpotCtx,
  deal: RazzDeal | null,
  action: RazzActionLabel,
): BetState {
  const s = cloneState(state)
  const a = s.actor
  s.hist += ACTION_CHAR[action]
  switch (action) {
    case 'fold':
      s.folded[a] = true
      s.pending[a] = false
      break
    case 'check':
      s.pending[a] = false
      break
    case 'call': {
      const pay = s.betLevel - s.contrib[a]
      s.contrib[a] = s.betLevel
      s.afterRoot[a] += pay
      s.pending[a] = false
      break
    }
    case 'bet':
    case 'complete':
    case 'raise': {
      const level = raisedLevel(s, ctx)
      const pay = level - s.contrib[a]
      s.contrib[a] = level
      s.afterRoot[a] += pay
      s.betLevel = level
      s.raises++
      for (let i = 0; i < ctx.n; i++) s.pending[i] = !s.folded[i] && i !== a
      break
    }
  }

  // フォールド勝ち
  if (activeCount(s) === 1) {
    s.pot += s.contrib.reduce((x, y) => x + y, 0)
    s.contrib.fill(0)
    s.winner = s.folded.indexOf(false)
    s.done = true
    s.actor = -1
    return s
  }

  // 次のアクター
  for (let k = 1; k <= ctx.n; k++) {
    const i = (a + k) % ctx.n
    if (!s.folded[i] && s.pending[i]) {
      s.actor = i
      return s
    }
  }

  // ストリートのベッティング終了
  s.pot += s.contrib.reduce((x, y) => x + y, 0)
  s.contrib.fill(0)
  if (s.street >= ctx.horizon) {
    s.done = true
    s.actor = -1
    return s
  }
  if (!deal) throw new Error('razz: actionsSoFar close the street before hero acts')
  s.street++
  s.betLevel = 0
  s.raises = 0
  for (let i = 0; i < ctx.n; i++) s.pending[i] = !s.folded[i]
  s.actor = firstToActFromUps(upsAtStreet(deal, s.street), s.folded)
  s.hist += '/'
  return s
}

function utilityOf(state: BetState, deal: RazzDeal, player: number): number {
  if (state.winner >= 0) {
    return (player === state.winner ? state.pot : 0) - state.afterRoot[player]
  }
  if (state.folded[player]) return -state.afterRoot[player]
  let best = Infinity
  for (let i = 0; i < state.folded.length; i++) {
    if (!state.folded[i] && deal.showdownKey[i] < best) best = deal.showdownKey[i]
  }
  if (deal.showdownKey[player] !== best) return -state.afterRoot[player]
  let winners = 0
  for (let i = 0; i < state.folded.length; i++) {
    if (!state.folded[i] && deal.showdownKey[i] === best) winners++
  }
  return state.pot / winners - state.afterRoot[player]
}

function infosetKeyOf(state: BetState, deal: RazzDeal, ctx: SpotCtx): string {
  const p = state.actor
  const idx = state.street - 3
  let tiers = ''
  for (let i = 0; i < ctx.n; i++) {
    if (i === p) continue
    tiers += state.folded[i] ? 'F' : String(deal.boardTiers[i][idx])
  }
  return `${state.street}|${state.hist}|${deal.buckets[p][idx]}|${tiers}`
}

// ---- 配札サンプリング -----------------------------------------------------------

function sampleRazzDeal(
  ctx: SpotCtx,
  pool0: readonly Card[],
  fixedHeroDown: readonly Card[] | null,
  rng: () => number,
): RazzDeal {
  const street = ctx.root.street
  const pool = pool0.slice()
  const n = ctx.n

  // 伏せ札（レンジ重み付き）。7th では 3 枚目の伏せ札は配られたばかりなので一様。
  const downs: Card[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    if (i === ctx.heroIndex && fixedHeroDown) {
      downs[i] = [...fixedHeroDown]
      continue
    }
    const hidden = sampleHiddenCards(pool, 2, ctx.seatWeights[i], rng)
    if (street === 7) hidden.push(drawUniform(pool, rng))
    downs[i] = hidden
  }

  // 以降の配札（一様）と 7 枚のハンド構成 [d1, d2, up1..up4, d3]
  const knownUpCount = razzUpCount(street as RazzStreet)
  const hands: Card[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const futureUps: Card[] = []
    for (let k = knownUpCount; k < 4; k++) futureUps.push(drawUniform(pool, rng))
    const down3 = street === 7 ? downs[i][2] : drawUniform(pool, rng)
    hands[i] = [downs[i][0], downs[i][1], ...ctx.seats[i].up, ...futureUps, down3]
  }

  const showdownKey = hands.map((hand) => razzBestKey(hand))
  const buckets: number[][] = new Array(n)
  const boardTiers: number[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    buckets[i] = []
    boardTiers[i] = []
    for (let st = 3; st <= ctx.horizon; st++) {
      buckets[i].push(razzHandBucket(hands[i].slice(0, st === 7 ? 7 : st)))
      boardTiers[i].push(razzBoardTier(hands[i].slice(2, 2 + razzUpCount(st as RazzStreet))))
    }
  }
  return { hands, showdownKey, buckets, boardTiers }
}

// ---- スポット構築 ---------------------------------------------------------------

interface BuildInput {
  street: RazzStreet
  seats: RazzSeatInput[]
  dead: Card[]
  stakes: RazzStakes
  pot?: number
  bringInIndex?: number
  /** 現在ストリートの既出アクション（ラベルまたは 1 文字表記）。 */
  history: readonly string[]
  /** null = グリッド解析（履歴後の手番席を Hero に採用し、実ハンドは固定しない）。 */
  hero: { index: number; down: Card[] } | null
}

function buildCtx(input: BuildInput, opts: RazzSolveOptions): SpotCtx {
  const { street, seats, dead, hero } = input
  if (hero) {
    validateRazzInput({ street, seats, heroIndex: hero.index, heroDown: hero.down, dead })
  } else {
    validateRazzPublic(street, seats, dead)
  }
  const stakes: Required<RazzStakes> = { raiseCap: 4, ...input.stakes }
  if (stakes.ante < 0 || stakes.bringIn <= 0 || stakes.smallBet <= 0 || stakes.bigBet <= 0) {
    throw new Error('razz: stakes must be positive')
  }
  if (stakes.bringIn >= stakes.smallBet) {
    throw new Error('razz: bringIn must be smaller than smallBet')
  }
  if (street > 3 && input.pot == null) {
    throw new Error('razz: pot at street start is required for streets after 3rd')
  }

  const n = seats.length
  const state: BetState = {
    street,
    pot: input.pot ?? stakes.ante * n,
    contrib: new Array(n).fill(0),
    afterRoot: new Array(n).fill(0),
    folded: new Array(n).fill(false),
    pending: new Array(n).fill(true),
    betLevel: 0,
    raises: 0,
    actor: -1,
    done: false,
    winner: -1,
    hist: '',
  }

  if (street === 3) {
    const bi = input.bringInIndex ?? razzBringInIndex(seats)
    state.contrib[bi] = stakes.bringIn
    state.betLevel = stakes.bringIn
    state.actor = (bi + 1) % n
  } else {
    state.actor = firstToActFromUps(seats.map((s) => s.up), state.folded)
  }

  const range = opts.range ?? DEFAULT_RAZZ_RANGE
  const ctxPartial: SpotCtx = {
    seats,
    n,
    heroIndex: hero?.index ?? -1,
    heroDown: hero?.down ?? [],
    stakes,
    horizon: 7, // リプレイでは未使用（現在ストリート内のみ）。後で確定する。
    root: state,
    range,
    trainPool: [],
    evalPool: [],
    seatWeights: seats.map((s) => rankWeightTable(new Set(s.up.map(razzRank)), range)),
  }

  // 現在ストリートのアクション履歴をリプレイ（1 文字表記は合法アクションへ解決）
  let cur = state
  for (const raw of input.history) {
    if (cur.done || cur.actor < 0) throw new Error('razz: actionsSoFar continue past end of hand')
    const action = coerceRazzAction(raw, legalActionsOf(cur, ctxPartial))
    if (!action) {
      throw new Error(`razz: illegal action "${raw}" in actionsSoFar`)
    }
    cur = applyAction(cur, ctxPartial, null, action)
  }
  if (cur.done) throw new Error('razz: hand is already over after actionsSoFar')
  if (hero && cur.actor !== hero.index) {
    throw new Error(`razz: after actionsSoFar it is seat ${cur.actor}'s turn, not hero's`)
  }
  cur.afterRoot = new Array(n).fill(0)

  const heroIndex = hero?.index ?? cur.actor
  const heroDown = hero?.down ?? []
  const horizon = activeCount(cur) === 2 ? 7 : street
  const visible = [...seats.flatMap((s) => s.up), ...dead]
  return {
    ...ctxPartial,
    heroIndex,
    heroDown,
    horizon,
    root: cur,
    trainPool: remainingDeck(visible),
    evalPool: remainingDeck([...visible, ...heroDown]),
  }
}

function makeGame(ctx: SpotCtx, fixedHeroDown: readonly Card[] | null): CfrGame<RazzDeal, BetState> {
  const pool = fixedHeroDown ? ctx.evalPool : ctx.trainPool
  return {
    numPlayers: ctx.n,
    sampleDeal: (rng) => sampleRazzDeal(ctx, pool, fixedHeroDown, rng),
    initialState: () => ctx.root,
    isTerminal: (s) => s.done,
    utility: (s, deal, p) => utilityOf(s, deal, p),
    currentPlayer: (s) => s.actor,
    legalActions: (s) => legalActionsOf(s, ctx),
    nextState: (s, deal, a) => applyAction(s, ctx, deal, a as RazzActionLabel),
    infosetKey: (s, deal) => infosetKeyOf(s, deal, ctx),
  }
}

// ---- 公開 API -------------------------------------------------------------------

/**
 * Razz スポットを解き、Hero の各アクションの頻度と EV を返す。
 * 重い計算なので UI からは Web Worker 経由で呼ぶこと。
 */
export function solveRazzSpot(spot: RazzSpot, opts: RazzSolveOptions = {}): RazzSpotResult {
  const rng = opts.rng ?? mulberry32((Math.random() * 0xffffffff) >>> 0)
  const iterations = opts.iterations ?? 30000
  const evalSamples = opts.evalSamples ?? 6000
  const ctx = buildCtx(
    {
      street: spot.street,
      seats: spot.seats,
      dead: spot.dead ?? [],
      stakes: spot.stakes,
      pot: spot.pot,
      bringInIndex: spot.bringInIndex,
      history: spot.actionsSoFar ?? [],
      hero: { index: spot.heroIndex, down: spot.heroDown },
    },
    opts,
  )

  // 学習: Hero の伏せ札もレンジからサンプルして均衡を近似する
  const sol = runMccfr(makeGame(ctx, null), { iterations, rng, onProgress: opts.onProgress })

  // 評価: Hero の実ハンドを固定してアクションごとの EV をロールアウト推定
  const evalGame = makeGame(ctx, ctx.heroDown)
  const values = estimateActionValues(evalGame, sol, {
    player: ctx.heroIndex,
    samples: evalSamples,
    rng,
  })

  // Hero の実ハンドに対応する情報集合の平均戦略（バケット・ティアは公開情報から決定的）
  const heroKey = evalGame.infosetKey(ctx.root, evalGame.sampleDeal(rng))
  const rootActions = legalActionsOf(ctx.root, ctx)
  const freqs = averageStrategy(sol, heroKey, rootActions.length)

  // エクイティ（ルート時点のアクティブプレイヤーのみで再構成）
  const active: number[] = []
  for (let i = 0; i < ctx.n; i++) if (!ctx.root.folded[i]) active.push(i)
  const eqInput: RazzEquityInput = {
    street: spot.street,
    seats: active.map((i) => ctx.seats[i]),
    heroIndex: active.indexOf(ctx.heroIndex),
    heroDown: ctx.heroDown,
    dead: [
      ...(spot.dead ?? []),
      ...ctx.seats.flatMap((s, i) => (ctx.root.folded[i] ? s.up : [])),
    ],
  }
  const equity = estimateRazzEquity(eqInput, {
    iters: opts.equityIters ?? 4000,
    rng,
    range: ctx.range,
  })

  return {
    actions: rootActions.map((action, i) => ({
      action,
      frequency: freqs[i],
      ev: values[i].ev,
    })),
    equity: equity.equity,
    horizon: activeCount(ctx.root) === 2 ? 'river' : 'street',
    iterations,
    evalSamples,
  }
}

/** Razz ランク（1=A..13=K）からダミーカードを作る（バケット計算はランクのみ参照）。 */
function cardOfRazzRank(r: number): Card {
  return { rank: (r === 1 ? 14 : r) as Card['rank'], suit: 'c' }
}

/** 文字列履歴を 1 文字ずつの配列へ（空白・区切り記号は無視）。 */
function historyChars(history: RazzGridSpot['history']): readonly string[] {
  if (history == null) return []
  if (typeof history === 'string') return [...history.replace(/[\s/,.|-]+/g, '')]
  return history
}

/**
 * レンジグリッド解析: 履歴の後に手番となるプレイヤーについて、伏せ札 2 枚の
 * 全ランクペア（91 通り）の平均戦略を返す。実ハンドは固定せず、公開情報
 * （全員のアップカード + 履歴）だけで解く。バケット抽象化のため、同じバケットに
 * 落ちるランクペアは同一の戦略になる。7th street（伏せ札 3 枚）は非対応。
 * 重い計算なので UI からは Web Worker 経由で呼ぶこと。
 */
export function solveRazzRangeGrid(spot: RazzGridSpot, opts: RazzSolveOptions = {}): RazzGridResult {
  if (spot.street === 7) {
    throw new Error('razz: range grid is not supported on 7th street (3 downcards)')
  }
  const rng = opts.rng ?? mulberry32((Math.random() * 0xffffffff) >>> 0)
  const iterations = opts.iterations ?? 30000
  const ctx = buildCtx(
    {
      street: spot.street,
      seats: spot.seats,
      dead: spot.dead ?? [],
      stakes: spot.stakes,
      pot: spot.pot,
      bringInIndex: spot.bringInIndex,
      history: historyChars(spot.history),
      hero: null,
    },
    opts,
  )

  const sol = runMccfr(makeGame(ctx, null), { iterations, rng, onProgress: opts.onProgress })

  const actor = ctx.heroIndex
  const actions = legalActionsOf(ctx.root, ctx)

  // 情報集合キーの公開情報部分（infosetKeyOf と同じ構成。ボードティアは
  // 現在ストリートのアップカードから決定的に求まる）
  let tiers = ''
  for (let i = 0; i < ctx.n; i++) {
    if (i === actor) continue
    tiers += ctx.root.folded[i] ? 'F' : String(razzBoardTier(ctx.seats[i].up))
  }

  // ランクごとの残り枚数（見えているカードを除く）→ ランクペアのコンボ数
  const avail = new Array<number>(14).fill(0)
  for (const c of ctx.trainPool) avail[razzRank(c)]++

  const cells: RazzGridCell[] = []
  const totals = new Array<number>(actions.length).fill(0)
  let totalCombos = 0
  for (let r1 = 1; r1 <= 13; r1++) {
    for (let r2 = r1; r2 <= 13; r2++) {
      const combos =
        r1 === r2 ? (avail[r1] * (avail[r1] - 1)) / 2 : avail[r1] * avail[r2]
      const hand = [cardOfRazzRank(r1), cardOfRazzRank(r2), ...ctx.seats[actor].up]
      const bucket = razzHandBucket(hand)
      const key = `${ctx.root.street}|${ctx.root.hist}|${bucket}|${tiers}`
      const frequencies = averageStrategy(sol, key, actions.length)
      cells.push({ ranks: [r1, r2], combos, frequencies })
      if (combos > 0) {
        totalCombos += combos
        for (let i = 0; i < actions.length; i++) totals[i] += combos * frequencies[i]
      }
    }
  }
  if (totalCombos > 0) {
    for (let i = 0; i < actions.length; i++) totals[i] /= totalCombos
  }

  return {
    actorIndex: actor,
    actions,
    cells,
    totals,
    horizon: activeCount(ctx.root) === 2 ? 'river' : 'street',
    iterations,
  }
}

// ---- 履歴リプレイ（UI のアクションビルダー用） ------------------------------------

export interface RazzHistoryStep {
  seatIndex: number
  action: RazzActionLabel
}

export interface RazzHistoryReplay {
  /** 解決できた履歴（行動順）。 */
  steps: RazzHistoryStep[]
  /** 次に行動する席（ハンド / ストリート終了時は -1）。 */
  actorIndex: number
  /** 手番プレイヤーの合法アクション（終了時は空）。 */
  legalActions: RazzActionLabel[]
  /** true = これ以上入力できない（フォールド勝ち or 現在ストリートのベッティング終了）。 */
  done: boolean
  /** 現在のポット（現在ストリートの投入分・ブリングイン込み）。 */
  pot: number
  /** 手番プレイヤーがコールに必要な額（終了時は 0）。 */
  toCall: number
  /** 3rd street のブリングイン席（それ以外は -1）。 */
  bringInIndex: number
  folded: boolean[]
  /** 解決できないアクションがあった履歴位置（なければ -1）。steps はその直前まで。 */
  invalidAt: number
}

/**
 * MCCFR なしで履歴だけをリプレイし、手番・合法アクション・ポットを返す。
 * UI のアクション入力（ステップ入力・タイムライン表示）用の軽量ヘルパー。
 * 現在ストリートのベッティングが閉じた時点で done になる（次ストリートは非対応）。
 */
export function replayRazzHistory(spot: RazzGridSpot): RazzHistoryReplay {
  validateRazzPublic(spot.street, spot.seats, spot.dead ?? [])
  const stakes: Required<RazzStakes> = { raiseCap: 4, ...spot.stakes }
  if (stakes.ante < 0 || stakes.bringIn <= 0 || stakes.smallBet <= 0 || stakes.bigBet <= 0) {
    throw new Error('razz: stakes must be positive')
  }
  if (stakes.bringIn >= stakes.smallBet) {
    throw new Error('razz: bringIn must be smaller than smallBet')
  }
  const n = spot.seats.length
  const state: BetState = {
    street: spot.street,
    pot: spot.pot ?? stakes.ante * n,
    contrib: new Array(n).fill(0),
    afterRoot: new Array(n).fill(0),
    folded: new Array(n).fill(false),
    pending: new Array(n).fill(true),
    betLevel: 0,
    raises: 0,
    actor: -1,
    done: false,
    winner: -1,
    hist: '',
  }
  let bringInIndex = -1
  if (spot.street === 3) {
    bringInIndex = spot.bringInIndex ?? razzBringInIndex(spot.seats)
    state.contrib[bringInIndex] = stakes.bringIn
    state.betLevel = stakes.bringIn
    state.actor = (bringInIndex + 1) % n
  } else {
    state.actor = firstToActFromUps(spot.seats.map((s) => s.up), state.folded)
  }

  // horizon = 現在ストリート（ベッティングが閉じたら done。applyAction は deal 不要）
  const ctx: SpotCtx = {
    seats: spot.seats,
    n,
    heroIndex: -1,
    heroDown: [],
    stakes,
    horizon: spot.street,
    root: state,
    range: DEFAULT_RAZZ_RANGE,
    trainPool: [],
    evalPool: [],
    seatWeights: [],
  }

  const chars = historyChars(spot.history)
  const steps: RazzHistoryStep[] = []
  let cur = state
  let invalidAt = -1
  for (const [i, raw] of chars.entries()) {
    if (cur.done || cur.actor < 0) {
      invalidAt = i
      break
    }
    const action = coerceRazzAction(raw, legalActionsOf(cur, ctx))
    if (!action) {
      invalidAt = i
      break
    }
    steps.push({ seatIndex: cur.actor, action })
    cur = applyAction(cur, ctx, null, action)
  }

  const done = cur.done || cur.actor < 0
  return {
    steps,
    actorIndex: done ? -1 : cur.actor,
    legalActions: done ? [] : legalActionsOf(cur, ctx),
    done,
    pot: cur.pot + cur.contrib.reduce((x, y) => x + y, 0),
    toCall: done ? 0 : cur.betLevel - cur.contrib[cur.actor],
    bringInIndex,
    folded: [...cur.folded],
    invalidAt,
  }
}
