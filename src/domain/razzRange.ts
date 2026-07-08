// Razz の相手レンジモデル。
// 「ポットに参加している相手の伏せ札は低いカードに偏る」を重み付きサンプリングで表す。
// lowBias=0, pairPenalty=1 で一様ランダムに退化する（テスト・クロスチェック用）。

import { type Card } from './cards'
import { razzRank } from './razz'

export interface RazzRangeModel {
  /** 低カードへの偏りの強さ。重みは w(r) ∝ exp(-lowBias·(r-1)/12)。0 = 一様。 */
  lowBias: number
  /** 自分のアップカードとペアになるランクの抑制係数（0..1、1 = 抑制なし）。 */
  pairPenalty: number
}

/** 既定のレンジモデル（参加者は低札寄り・自ボードとのペアを避ける想定）。 */
export const DEFAULT_RAZZ_RANGE: RazzRangeModel = { lowBias: 1.5, pairPenalty: 0.5 }

/** 一様ランダム（不偏）。検証・比較用。 */
export const UNIFORM_RAZZ_RANGE: RazzRangeModel = { lowBias: 0, pairPenalty: 1 }

/** 伏せ札候補 1 枚の重み。 */
export function hiddenCardWeight(
  rank: number,
  ownUpRanks: ReadonlySet<number>,
  model: RazzRangeModel,
): number {
  let w = Math.exp((-model.lowBias * (rank - 1)) / 12)
  if (ownUpRanks.has(rank)) w *= model.pairPenalty
  return w
}

/**
 * ランク（1..13）→重みの事前計算テーブル。モンテカルロのホットパスで
 * exp() を繰り返さないため、シートごとに 1 回だけ作って使い回す。
 */
export function rankWeightTable(
  ownUpRanks: ReadonlySet<number>,
  model: RazzRangeModel,
): Float64Array {
  const table = new Float64Array(14)
  for (let r = 1; r <= 13; r++) table[r] = hiddenCardWeight(r, ownUpRanks, model)
  return table
}

/**
 * pool から重み付きで count 枚を非復元抽出する。pool は破壊的に縮む。
 * weights は rankWeightTable で作ったテーブル。
 * rng は [0,1) を返す関数（決定論テストのため注入可能）。
 */
export function sampleHiddenCards(
  pool: Card[],
  count: number,
  weights: Float64Array,
  rng: () => number,
): Card[] {
  const picked: Card[] = []
  for (let k = 0; k < count; k++) {
    let total = 0
    for (const c of pool) total += weights[razzRank(c)]
    let idx = -1
    if (total <= 0) {
      // 全重みゼロ（極端なパラメータ）のときは一様にフォールバック
      idx = Math.floor(rng() * pool.length)
    } else {
      let threshold = rng() * total
      for (let i = 0; i < pool.length; i++) {
        threshold -= weights[razzRank(pool[i])]
        if (threshold <= 0) {
          idx = i
          break
        }
      }
      if (idx < 0) idx = pool.length - 1 // 浮動小数の取りこぼし
    }
    picked.push(pool[idx])
    pool[idx] = pool[pool.length - 1]
    pool.pop()
  }
  return picked
}

/** pool から一様に 1 枚引く（破壊的）。 */
export function drawUniform(pool: Card[], rng: () => number): Card {
  const idx = Math.floor(rng() * pool.length)
  const card = pool[idx]
  pool[idx] = pool[pool.length - 1]
  pool.pop()
  return card
}
