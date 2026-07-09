// 2-7 ローボール（deuce-to-seven）の 5 枚評価。
// ホールデムの役の強さがそのまま「弱さ」になる: ベストハンドは 7-5-4-3-2（オフスート）。
// A は常にハイ、ストレート・フラッシュはカウントする（A2345 はストレートではない）。
// razz.ts と同じ流儀で、参照実装 lowballValue5（配列・辞書式）と高速版 lowballKey5
// （整数パック）の二本立て。クロスチェックテストで一致を担保する。

import { type Card } from './cards'

/** 2-7 用ランク（2..14、A=14 固定ハイ）。ジョーカー非対応。 */
export function lowballRank(card: Card): number {
  if (card.rank === 0) throw new Error('lowball: jokers are not supported')
  return card.rank
}

/**
 * 5枚の 2-7 ロー値（参照実装）。[カテゴリ, ...タイブレーカー(降順ランク)] の
 * 辞書式比較で小さい方が強い。
 * カテゴリ: 0=ノーペア(ストレート/フラッシュなし) 1=ワンペア 2=ツーペア 3=トリップス
 *           4=ストレート 5=フラッシュ 6=フルハウス 7=クオッズ 8=ストレートフラッシュ
 */
export function lowballValue5(cards: readonly Card[]): number[] {
  if (cards.length !== 5) throw new Error(`lowballValue5: need 5 cards, got ${cards.length}`)
  const ranks = cards.map(lowballRank).sort((a, b) => b - a)
  const suits = new Set(cards.map((c) => c.suit))
  const counts = new Map<number, number>()
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1)

  const isFlush = suits.size === 1
  // ストレート: 5 連続（A はハイのみ。A2345 は不成立）
  const distinct = [...counts.keys()].sort((a, b) => b - a)
  const isStraight = distinct.length === 5 && distinct[0] - distinct[4] === 4

  // タイブレーカー: 枚数の多い組 → ランクの高い順（ハイハンド比較と同じ並び。
  // 小さい方が強い評価なので、この並びの辞書式比較がそのまま使える）
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const tiebreak: number[] = []
  for (const [r, c] of groups) for (let i = 0; i < c; i++) tiebreak.push(r)

  let category: number
  if (isStraight && isFlush) category = 8
  else if (groups[0][1] === 4) category = 7
  else if (groups[0][1] === 3 && groups[1][1] === 2) category = 6
  else if (isFlush) category = 5
  else if (isStraight) category = 4
  else if (groups[0][1] === 3) category = 3
  else if (groups[0][1] === 2 && groups[1][1] === 2) category = 2
  else if (groups[0][1] === 2) category = 1
  else category = 0
  return [category, ...tiebreak]
}

/** lowballValue5 の整数パック（基数15）。小さいほど強い。ホットパス用。 */
export function lowballKey5(cards: readonly Card[]): number {
  const v = lowballValue5(cards)
  let key = 0
  for (const x of v) key = key * 15 + x
  return key
}

/** 2-7 値の辞書式比較（負 = a が強い）。 */
export function compareLowballValues(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
