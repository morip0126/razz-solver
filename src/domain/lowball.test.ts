// 2-7 ロー評価のテスト。既知の順序とランダムクロスチェック。

import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import { makeDeck } from './cards'
import { compareLowballValues, lowballKey5, lowballValue5 } from './lowball'

const v = (s: string) => lowballValue5(parseCards(s))
const k = (s: string) => lowballKey5(parseCards(s))

describe('lowballValue5', () => {
  it('既知の強さ順序（小さいほど強い）', () => {
    // ナッツ: 7-5-4-3-2 オフスート
    const order = [
      '7c 5d 4h 3s 2c', // #1
      '7c 6d 4h 3s 2c', // #2
      '7c 6d 5h 3s 2c', // #3
      '8c 5d 4h 3s 2c', // 8 ロー
      '9c 5d 4h 3s 2c',
      'Tc 8d 6h 4s 2c',
      'Jc 8d 6h 4s 2c',
      'Ac 8d 6h 4s 2c', // A はハイ
      '2c 2d 4h 5s 7c', // ワンペア
      '2c 2d 3h 3s 7c', // ツーペア
      '2c 2d 2h 4s 7c', // トリップス
      '6c 5d 4h 3s 2c', // ストレート
      '8c 5c 4c 3c 2c', // フラッシュ
      '2c 2d 2h 3s 3c', // フルハウス
      '2c 2d 2h 2s 7c', // クオッズ
      '6c 5c 4c 3c 2c', // ストレートフラッシュ
    ]
    for (let i = 1; i < order.length; i++) {
      expect(compareLowballValues(v(order[i - 1]), v(order[i]))).toBeLessThan(0)
      expect(k(order[i - 1])).toBeLessThan(k(order[i]))
    }
  })

  it('A2345 はストレートではなく A ハイ、TJQKA はストレート', () => {
    expect(v('Ac 2d 3h 4s 5c')[0]).toBe(0) // ノーペア（A ハイ）
    expect(v('Tc Jd Qh Ks Ac')[0]).toBe(4) // ストレート
    // A ハイのノーペアはどの 8 ローよりも弱いが、ペアよりは強い
    expect(compareLowballValues(v('8c 5d 4h 3s 2c'), v('Ac 2d 3h 4s 5c'))).toBeLessThan(0)
    expect(compareLowballValues(v('Ac 2d 3h 4s 5c'), v('2c 2d 4h 5s 7c'))).toBeLessThan(0)
  })

  it('value と key の順序が全ランダムサンプルで一致する', () => {
    const rng = mulberry32(7)
    const deck = makeDeck()
    for (let t = 0; t < 2000; t++) {
      const pool = deck.slice()
      const pick = () => pool.splice(Math.floor(rng() * pool.length), 1)[0]
      const a = [pick(), pick(), pick(), pick(), pick()]
      const b = [pick(), pick(), pick(), pick(), pick()]
      const cmpV = Math.sign(compareLowballValues(lowballValue5(a), lowballValue5(b)))
      const cmpK = Math.sign(lowballKey5(a) - lowballKey5(b))
      expect(cmpK).toBe(cmpV)
    }
  })
})
