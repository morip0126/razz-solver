import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import {
  compareRazzValues,
  packRazzValue,
  razzBestKey,
  razzBestValue,
  razzBoardKey,
  razzKey5,
  razzRank,
  razzValue5,
} from './razz'

describe('razzValue5 (参照実装)', () => {
  it('ホイール（A2345）が最強のノーペア', () => {
    expect(razzValue5(parseCards('Ah 2c 3d 4s 5h'))).toEqual([0, 5, 4, 3, 2, 1])
  })

  it('既知のハンド順序（強い順）', () => {
    const ordered = [
      'Ah 2c 3d 4s 5h', // 5-4-3-2-A（ホイール）
      'Ah 2c 3d 4s 6h', // 6-4-3-2-A
      '2h 3c 4d 5s 6h', // 6-5-4-3-2
      'Ah 2c 3d 4s 7h', // 7-4-3-2-A
      'Ah 2c 3d 4s 8h', // 8-4-3-2-A
      'Ah 2c 3d 5s 8h', // 8-5-3-2-A
      '4h 5c 6d 7s 8h', // 8-7-6-5-4
      'Ah 2c 3d 4s 9h', // 9-4-3-2-A
      '9h Tc Jd Qs Kh', // K-Q-J-T-9（最弱のノーペア）
      'Ah Ac 2d 3s 4h', // ペア A（どのノーペアよりも弱い）
      '2h 2c 3d 4s 5h', // ペア 2
      'Ah Ac 2d 2s 3h', // ツーペア
      'Ah Ac Ad 2s 3h', // トリップス
      'Ah Ac Ad 2s 2h', // フルハウス
      'Ah Ac Ad As 2h', // クオッズ
    ]
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = razzValue5(parseCards(ordered[i]))
      const b = razzValue5(parseCards(ordered[i + 1]))
      expect(compareRazzValues(a, b), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0)
    }
  })

  it('ストレート・フラッシュはノーカウント', () => {
    // 同ランク構成ならスーテッドでも同値
    const suited = razzValue5(parseCards('2h 3h 4h 5h 7h'))
    const offsuit = razzValue5(parseCards('2c 3d 4h 5s 7c'))
    expect(compareRazzValues(suited, offsuit)).toBe(0)
  })

  it('ジョーカーは拒否する', () => {
    expect(() => razzValue5(parseCards('X1 2c 3d 4s 5h'))).toThrow()
  })
})

describe('razzKey5 (高速版) と参照実装のクロスチェック', () => {
  it('全ランク多重集合で packRazzValue(razzValue5) と一致する', () => {
    const suits = ['c', 'd', 'h', 's'] as const
    const chars = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']
    // r1 <= r2 <= ... <= r5（同ランクは4枚まで）の全多重集合を列挙
    let checked = 0
    for (let a = 0; a < 13; a++)
      for (let b = a; b < 13; b++)
        for (let c = b; c < 13; c++)
          for (let d = c; d < 13; d++)
            for (let e = d; e < 13; e++) {
              const ranks = [a, b, c, d, e]
              // 同ランクにはスートを順番に割り当て（5枚同ランクは存在しない）
              const used = new Map<number, number>()
              let valid = true
              const codes = ranks.map((r) => {
                const k = used.get(r) ?? 0
                if (k >= 4) valid = false
                used.set(r, k + 1)
                return `${chars[r]}${suits[k % 4]}`
              })
              if (!valid) continue
              const cards = parseCards(codes)
              expect(razzKey5(cards)).toBe(packRazzValue(razzValue5(cards)))
              checked++
            }
    expect(checked).toBeGreaterThan(6000)
  })
})

describe('razzBestKey / razzBestValue (ベスト5枚)', () => {
  it('7枚からホイールを見つける', () => {
    const cards = parseCards('Ah 2c 3d 4s 5h Kc Kd')
    expect(razzBestValue(cards)).toEqual([0, 5, 4, 3, 2, 1])
    expect(razzBestKey(cards)).toBe(packRazzValue([0, 5, 4, 3, 2, 1]))
  })

  it('ペアを強制される7枚では最小ペアを選ぶ', () => {
    // {2,2,3,3,4,4,5}: ベストは 2 のペア + 5,4,3
    const cards = parseCards('2h 2c 3d 3s 4h 4c 5d')
    expect(razzBestValue(cards)).toEqual([1, 2, 5, 4, 3])
  })

  it('6枚にも対応する', () => {
    const cards = parseCards('Ah 2c 3d 4s 9h 8c')
    expect(razzBestValue(cards)).toEqual([0, 8, 4, 3, 2, 1])
  })

  it('参照実装（razzBestValue）と高速版（razzBestKey）が一致する', () => {
    // 決定論的に生成した 7 枚ハンドでクロスチェック
    const chars = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']
    const suits = ['c', 'd', 'h', 's'] as const
    for (let seed = 0; seed < 300; seed++) {
      const ids = new Set<number>()
      let x = seed * 2654435761
      while (ids.size < 7) {
        x = (x * 1103515245 + 12345) >>> 0
        ids.add(x % 52)
      }
      const cards = parseCards(
        [...ids].map((id) => `${chars[Math.floor(id / 4)]}${suits[id % 4]}`),
      )
      expect(razzBestKey(cards)).toBe(packRazzValue(razzBestValue(cards)))
    }
  })
})

describe('razzRank / razzBoardKey', () => {
  it('A は 1（最小）', () => {
    expect(razzRank(parseCards('Ah')[0])).toBe(1)
    expect(razzRank(parseCards('Kh')[0])).toBe(13)
  })

  it('低いボードほどキーが小さく、ペアボードは高い', () => {
    const key = (s: string) => razzBoardKey(parseCards(s))
    expect(key('Ah 2c')).toBeLessThan(key('2h 3c'))
    expect(key('2h 3c')).toBeLessThan(key('Kh 2c'))
    expect(key('Kh 2c')).toBeLessThan(key('2h 2c')) // ペアはノーペアのどのボードより高い
  })
})
