// Razz（セブンカードスタッド・ローボール）の A-5 ロー評価。
// A は常に 1（最小）、ストレート/フラッシュはノーカウント。値は「小さいほど強い」。
// 参照実装 razzValue5（配列・辞書式）と高速版 razzKey5（整数パック）を持ち、
// クロスチェックテスト（razz.test.ts）で一致を担保する。ジョーカーは非対応。

import { type Card } from './cards'
import { combinations } from './combinatorics'

export type RazzStreet = 3 | 4 | 5 | 6 | 7

/** A=1 とした Razz 用ランク（1..13）。ジョーカー（rank 0）は使えない。 */
export function razzRank(card: Card): number {
  if (card.rank === 0) throw new Error('razz: jokers are not supported')
  return card.rank === 14 ? 1 : card.rank
}

/** ストリートごとのアップカード枚数（3rd=1 … 6th=4、7th も 4）。 */
export function razzUpCount(street: RazzStreet): number {
  return street === 7 ? 4 : street - 2
}

/** ストリートごとの伏せ札枚数（3rd〜6th=2、7th=3）。 */
export function razzDownCount(street: RazzStreet): number {
  return street === 7 ? 3 : 2
}

/**
 * 5枚の A-5 ロー値（参照実装）。
 * 返り値は [カテゴリ, ...タイブレーカー] の配列で、辞書式比較で小さい方が強い。
 * カテゴリ: 0=ノーペア, 1=ワンペア, 2=ツーペア, 3=トリップス, 4=フルハウス, 5=クオッズ。
 * タイブレーカーは「枚数の多い組 → ランクの高い順」（通常のハイハンド比較の逆読み）。
 */
export function razzValue5(cards: readonly Card[]): number[] {
  if (cards.length !== 5) throw new Error(`razzValue5: need 5 cards, got ${cards.length}`)
  const counts = new Map<number, number>()
  for (const c of cards) {
    const r = razzRank(c)
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  // 枚数の多い順 → 同枚数ならランクの高い順
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const pattern = groups.map(([, n]) => n)
  let category: number
  if (pattern[0] === 4) category = 5
  else if (pattern[0] === 3 && pattern[1] === 2) category = 4
  else if (pattern[0] === 3) category = 3
  else if (pattern[0] === 2 && pattern[1] === 2) category = 2
  else if (pattern[0] === 2) category = 1
  else category = 0
  return [category, ...groups.map(([r]) => r)]
}

/** razzValue5 同士の辞書式比較（負なら a が強い）。 */
export function compareRazzValues(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** razzValue5 の配列を単一整数にパックする（小さいほど強い）。基数14。 */
export function packRazzValue(value: readonly number[]): number {
  let key = value[0]
  for (let i = 1; i <= 5; i++) key = key * 14 + (value[i] ?? 0)
  return key
}

// 高速版のためのスクラッチ（シングルスレッド前提で使い回す）
const CNT = new Uint8Array(14)

/** Razz ランク配列（5個）から直接パックキーを計算する（アロケーションなし）。 */
export function razzKey5FromRanks(ranks: readonly number[]): number {
  CNT.fill(0)
  for (let i = 0; i < 5; i++) CNT[ranks[i]]++
  // カテゴリ判定
  let pairs = 0
  let trips = 0
  let quads = 0
  for (let r = 1; r <= 13; r++) {
    const n = CNT[r]
    if (n === 2) pairs++
    else if (n === 3) trips++
    else if (n === 4) quads++
  }
  const category = quads > 0 ? 5 : trips > 0 && pairs > 0 ? 4 : trips > 0 ? 3 : pairs === 2 ? 2 : pairs === 1 ? 1 : 0
  // タイブレーカー: 枚数の多い組 → ランクの高い順
  let key = category
  let digits = 0
  for (let m = 4; m >= 1; m--) {
    for (let r = 13; r >= 1; r--) {
      if (CNT[r] === m) {
        key = key * 14 + r
        digits++
      }
    }
  }
  for (; digits < 5; digits++) key = key * 14
  return key
}

/** 5枚のパックキー（razzValue5 と同順序になることをテストで担保）。 */
export function razzKey5(cards: readonly Card[]): number {
  if (cards.length !== 5) throw new Error(`razzKey5: need 5 cards, got ${cards.length}`)
  return razzKey5FromRanks(cards.map(razzRank))
}

// 5..7枚 → 5枚を選ぶインデックス組み合わせ（事前計算）
const PICK5: Record<number, number[][]> = {
  5: combinations([0, 1, 2, 3, 4], 5),
  6: combinations([0, 1, 2, 3, 4, 5], 5),
  7: combinations([0, 1, 2, 3, 4, 5, 6], 5),
}

const RANK_SCRATCH = new Array<number>(5)

/** 5〜7枚からベスト5枚の A-5 ロー・パックキーを返す（小さいほど強い）。 */
export function razzBestKey(cards: readonly Card[]): number {
  const combos = PICK5[cards.length]
  if (!combos) throw new Error(`razzBestKey: need 5-7 cards, got ${cards.length}`)
  const ranks = cards.map(razzRank)
  let best = Infinity
  for (const combo of combos) {
    for (let i = 0; i < 5; i++) RANK_SCRATCH[i] = ranks[combo[i]]
    const key = razzKey5FromRanks(RANK_SCRATCH)
    if (key < best) best = key
  }
  return best
}

/** 5〜7枚からベスト5枚のロー値（参照実装ベース、テスト・表示用）。 */
export function razzBestValue(cards: readonly Card[]): number[] {
  const combos = PICK5[cards.length]
  if (!combos) throw new Error(`razzBestValue: need 5-7 cards, got ${cards.length}`)
  let best: number[] | null = null
  for (const combo of combos) {
    const v = razzValue5(combo.map((i) => cards[i]))
    if (!best || compareRazzValues(v, best) < 0) best = v
  }
  return best!
}

/**
 * アップカードだけの「ボードの低さ」キー（小さいほど低い）。
 * Razz では 4th street 以降、最も低いボードが先にアクションする。
 * ペアのあるボードは高い扱い。同値は呼び出し側でシート順により決める。
 */
export function razzBoardKey(up: readonly Card[]): number {
  const ranks = up.map(razzRank).sort((a, b) => b - a)
  const distinct = new Set(ranks).size
  let key = ranks.length - distinct // 0 = ペアなし
  for (let i = 0; i < 4; i++) key = key * 14 + (ranks[i] ?? 0)
  return key
}
