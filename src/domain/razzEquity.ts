// Razz のショーダウンエクイティ（モンテカルロ）。
// 相手の見えているアップカードは固定し、伏せ札はレンジモデルで重み付き抽選、
// 以降の配札は一様に抽選してショーダウン比較する。rng 注入で決定論的に再現可能。

import { type Card, cardId, cardToString, remainingDeck } from './cards'
import {
  type RazzStreet,
  razzBestKey,
  razzDownCount,
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

export interface RazzSeatInput {
  /** 見えているアップカード（配られた順）。 */
  up: Card[]
}

export interface RazzEquityInput {
  street: RazzStreet
  /** アクティブな全プレイヤー（Hero 含む、シート順）。 */
  seats: RazzSeatInput[]
  heroIndex: number
  /** Hero の伏せ札（3rd〜6th は 2 枚、7th は 3 枚）。 */
  heroDown: Card[]
  /** フォールドで見えたカードなどのデッドカード。 */
  dead?: Card[]
}

export interface RazzEquityOptions {
  iters?: number
  rng?: () => number
  range?: RazzRangeModel
}

export interface RazzEquityResult {
  /** ポット取り分の期待値（タイは等分）。 */
  equity: number
  winProb: number
  tieProb: number
  /** Hero の最終ハンドが 7 ロー以下 / 8 ロー以下（ノーペア）になる確率。 */
  low7: number
  low8: number
  iters: number
}

// ノーペア（カテゴリ0）で最高札が N 以下 ⇔ key < N+1 の基数14桁境界
const KEY_LOW7 = 8 * 14 ** 4
const KEY_LOW8 = 9 * 14 ** 4

/**
 * 公開情報（席数・アップカード枚数・重複・ジョーカー）の整合性チェック。
 * extra には伏せ札やデッドカードなど、重複チェックに含めたいカードを渡す。
 * グリッドソルバー（Hero の実ハンドを固定しない解析）からも使う。
 */
export function validateRazzPublic(
  street: RazzStreet,
  seats: readonly RazzSeatInput[],
  extra: readonly Card[] = [],
): void {
  if (seats.length < 2 || seats.length > 6) {
    throw new Error(`razz: 2-6 players supported, got ${seats.length}`)
  }
  const upCount = razzUpCount(street)
  for (const [i, seat] of seats.entries()) {
    if (seat.up.length !== upCount) {
      throw new Error(`razz: seat ${i} needs ${upCount} upcards on street ${street}, got ${seat.up.length}`)
    }
  }
  const seen = new Set<number>()
  for (const c of [...seats.flatMap((s) => s.up), ...extra]) {
    razzRank(c) // ジョーカー検出
    const id = cardId(c)
    if (seen.has(id)) throw new Error(`razz: duplicate card ${cardToString(c)}`)
    seen.add(id)
  }
}

/** 入力の整合性チェック（枚数・重複・ジョーカー）。razzGame からも使う。 */
export function validateRazzInput(input: RazzEquityInput): void {
  const { street, seats, heroIndex, heroDown, dead = [] } = input
  if (heroIndex < 0 || heroIndex >= seats.length) throw new Error('razz: bad heroIndex')
  const downCount = razzDownCount(street)
  if (heroDown.length !== downCount) {
    throw new Error(`razz: hero needs ${downCount} downcards on street ${street}, got ${heroDown.length}`)
  }
  validateRazzPublic(street, seats, [...heroDown, ...dead])
}

/** Hero のショーダウンエクイティをモンテカルロで推定する。 */
export function estimateRazzEquity(
  input: RazzEquityInput,
  opts: RazzEquityOptions = {},
): RazzEquityResult {
  validateRazzInput(input)
  const { street, seats, heroIndex, heroDown, dead = [] } = input
  const iters = opts.iters ?? 5000
  const rng = opts.rng ?? Math.random
  const range = opts.range ?? DEFAULT_RAZZ_RANGE

  const basePool = remainingDeck([...seats.flatMap((s) => s.up), ...heroDown, ...dead])
  const futureCount = 7 - street
  const oppWeights = seats.map((s) => rankWeightTable(new Set(s.up.map(razzRank)), range))

  let equity = 0
  let wins = 0
  let ties = 0
  let low7 = 0
  let low8 = 0

  const keys = new Array<number>(seats.length)
  for (let it = 0; it < iters; it++) {
    const pool = basePool.slice()
    // 相手の伏せ札（レンジ重み付き）。7th はさらに 1 枚（配られたばかりの札）を一様に。
    const hands: Card[][] = seats.map((seat, i) => {
      if (i === heroIndex) return [...heroDown, ...seat.up]
      const hidden = sampleHiddenCards(pool, 2, oppWeights[i], rng)
      if (street === 7) hidden.push(drawUniform(pool, rng))
      return [...hidden, ...seat.up]
    })
    // 以降の配札（全員一様）
    for (const hand of hands) {
      for (let k = 0; k < futureCount; k++) hand.push(drawUniform(pool, rng))
    }
    let best = Infinity
    for (let i = 0; i < seats.length; i++) {
      keys[i] = razzBestKey(hands[i])
      if (keys[i] < best) best = keys[i]
    }
    const heroKey = keys[heroIndex]
    if (heroKey < KEY_LOW7) low7++
    if (heroKey < KEY_LOW8) low8++
    if (heroKey === best) {
      let winners = 0
      for (let i = 0; i < seats.length; i++) if (keys[i] === best) winners++
      if (winners === 1) wins++
      else ties++
      equity += 1 / winners
    }
  }

  return {
    equity: equity / iters,
    winProb: wins / iters,
    tieProb: ties / iters,
    low7: low7 / iters,
    low8: low8 / iters,
    iters,
  }
}
