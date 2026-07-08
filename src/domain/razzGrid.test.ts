// レンジグリッド解析（solveRazzRangeGrid）のテスト。
// 厳密解との比較は不可能なので、コンボ数の会計・決定論性・定性的な戦略の性質を検証する。

import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import {
  type RazzGridSpot,
  coerceRazzAction,
  solveRazzRangeGrid,
} from './razzGame'

const STAKES = { ante: 1, bringIn: 2, smallBet: 4, bigBet: 8 }

// スクリーンショット再現スポット: 6人、アップカード J T 7 6 8 K。
// K（seat 5）がブリングイン → seat 0 から f f f f、seat 4 がコンプリート("r")、
// 手番はブリングインの seat 5。アクティブは 2 人なのでフルツリー（river）。
const GRID_SPOT: RazzGridSpot = {
  street: 3,
  seats: [
    { up: parseCards('Jc') },
    { up: parseCards('Tc') },
    { up: parseCards('7c') },
    { up: parseCards('6c') },
    { up: parseCards('8c') },
    { up: parseCards('Kc') },
  ],
  stakes: STAKES,
  history: 'ffffr',
}

function cell(r: ReturnType<typeof solveRazzRangeGrid>, r1: number, r2: number) {
  const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1]
  const c = r.cells.find((x) => x.ranks[0] === lo && x.ranks[1] === hi)
  if (!c) throw new Error(`cell (${lo},${hi}) not found`)
  return c
}

function freq(r: ReturnType<typeof solveRazzRangeGrid>, c: { frequencies: number[] }, action: string) {
  const i = r.actions.indexOf(action as never)
  if (i < 0) throw new Error(`action ${action} not offered`)
  return c.frequencies[i]
}

describe('solveRazzRangeGrid', () => {
  it('コンボ数の会計とグリッドの形が正しい', () => {
    const r = solveRazzRangeGrid(GRID_SPOT, { iterations: 300, rng: mulberry32(1) })
    expect(r.actorIndex).toBe(5)
    expect(r.horizon).toBe('river')
    // ブリングイン(2)にコンプリート(4)が乗った状態 → fold / call / raise
    expect(r.actions).toEqual(['fold', 'call', 'raise'])
    expect(r.cells).toHaveLength(91)
    // 総コンボ数 = C(52-6, 2) = C(46,2) = 1035
    const total = r.cells.reduce((x, c) => x + c.combos, 0)
    expect(total).toBe(1035)
    // K はアップに 1 枚見えている → KK のコンボは C(3,2)=3、A は 4 枚 → AA は C(4,2)=6
    expect(cell(r, 13, 13).combos).toBe(3)
    expect(cell(r, 1, 1).combos).toBe(6)
    expect(cell(r, 1, 13).combos).toBe(4 * 3)
    // 各セルの頻度と全体頻度は確率分布
    for (const c of r.cells) {
      expect(c.frequencies.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6)
    }
    expect(r.totals.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6)
  })

  it('強い伏せ札（A2）は弱い伏せ札（QJ）よりフォールドが少ない', () => {
    const r = solveRazzRangeGrid(GRID_SPOT, { iterations: 4000, rng: mulberry32(2) })
    const strongFold = freq(r, cell(r, 1, 2), 'fold') // (A,2) + K up
    const weakFold = freq(r, cell(r, 11, 12), 'fold') // (J,Q) + K up
    expect(strongFold).toBeLessThan(weakFold)
    expect(strongFold).toBeLessThan(0.5)
  })

  it('同一シードで決定論的に再現する', () => {
    const a = solveRazzRangeGrid(GRID_SPOT, { iterations: 300, rng: mulberry32(3) })
    const b = solveRazzRangeGrid(GRID_SPOT, { iterations: 300, rng: mulberry32(3) })
    expect(a).toEqual(b)
  })

  it('3人以上が残っていれば現在ストリートのみの近似（street）', () => {
    const r = solveRazzRangeGrid(
      { ...GRID_SPOT, history: 'fff' }, // seat 3,4,5 が残る
      { iterations: 200, rng: mulberry32(4) },
    )
    expect(r.horizon).toBe('street')
    expect(r.actorIndex).toBe(3)
  })

  it('入力検証: 7th 非対応、ハンド終了後の履歴はエラー', () => {
    expect(() =>
      solveRazzRangeGrid({ ...GRID_SPOT, street: 7 }, { iterations: 10 }),
    ).toThrow(/7th/)
    // 5 人フォールドでハンド終了 → 履歴が余る
    expect(() =>
      solveRazzRangeGrid({ ...GRID_SPOT, history: 'fffff' }, { iterations: 10 }),
    ).toThrow(/over/)
    expect(() =>
      solveRazzRangeGrid({ ...GRID_SPOT, history: 'zf' }, { iterations: 10 }),
    ).toThrow(/illegal/)
  })
})

describe('coerceRazzAction', () => {
  it('1文字表記を局面の合法アクションへ解決する', () => {
    expect(coerceRazzAction('r', ['fold', 'call', 'complete'])).toBe('complete')
    expect(coerceRazzAction('r', ['fold', 'call', 'raise'])).toBe('raise')
    expect(coerceRazzAction('b', ['check', 'bet'])).toBe('bet')
    expect(coerceRazzAction('c', ['check', 'bet'])).toBe('check')
    expect(coerceRazzAction('c', ['fold', 'call', 'raise'])).toBe('call')
    expect(coerceRazzAction('x', ['check', 'bet'])).toBe('check')
    expect(coerceRazzAction('fold', ['fold', 'call'])).toBe('fold')
    // レイズキャップ到達後の r は解決不能
    expect(coerceRazzAction('r', ['fold', 'call'])).toBeNull()
    expect(coerceRazzAction('z', ['fold', 'call'])).toBeNull()
  })
})
