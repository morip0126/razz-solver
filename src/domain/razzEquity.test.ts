import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import { type RazzEquityInput, estimateRazzEquity } from './razzEquity'
import { UNIFORM_RAZZ_RANGE } from './razzRange'

describe('estimateRazzEquity', () => {
  it('同一シードで決定論的に再現する', () => {
    const input: RazzEquityInput = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('Kd') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
    }
    const a = estimateRazzEquity(input, { iters: 500, rng: mulberry32(42) })
    const b = estimateRazzEquity(input, { iters: 500, rng: mulberry32(42) })
    expect(a).toEqual(b)
  })

  it('7th でホイール（ナッツ）はほぼ勝つ', () => {
    const input: RazzEquityInput = {
      street: 7,
      seats: [{ up: parseCards('3c 4d 5h Kd') }, { up: parseCards('6c 8d 9h Td') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2c 7s'),
    }
    const r = estimateRazzEquity(input, { iters: 2000, rng: mulberry32(1) })
    expect(r.equity).toBeGreaterThan(0.95)
    expect(r.low7).toBe(1) // ホイールは常に 7 ロー以下
  })

  it('3rd の A-2-3 は K アップの相手より有利', () => {
    const input: RazzEquityInput = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('Kd') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
    }
    const r = estimateRazzEquity(input, { iters: 3000, rng: mulberry32(7) })
    expect(r.equity).toBeGreaterThan(0.6)
  })

  it('ペアだらけのハンドは低ボードの相手に不利', () => {
    const input: RazzEquityInput = {
      street: 5,
      seats: [{ up: parseCards('Kc Kd Qh') }, { up: parseCards('2c 4d 6h') }],
      heroIndex: 0,
      heroDown: parseCards('Ks Qd'),
    }
    const r = estimateRazzEquity(input, { iters: 3000, rng: mulberry32(3) })
    expect(r.equity).toBeLessThan(0.25)
  })

  it('相手が増えるとエクイティは下がる', () => {
    const heroDown = parseCards('Ah 2s')
    const hu: RazzEquityInput = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('8d') }],
      heroIndex: 0,
      heroDown,
    }
    const three: RazzEquityInput = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('8d') }, { up: parseCards('9h') }],
      heroIndex: 0,
      heroDown,
    }
    const opts = { iters: 3000, rng: mulberry32(11) }
    const rHu = estimateRazzEquity(hu, opts)
    const r3 = estimateRazzEquity(three, { ...opts, rng: mulberry32(11) })
    expect(r3.equity).toBeLessThan(rHu.equity)
  })

  it('レンジ重み付けは一様より Hero のエクイティを下げる（相手が低札寄りになる）', () => {
    const input: RazzEquityInput = {
      street: 4,
      seats: [{ up: parseCards('3c 7s') }, { up: parseCards('5d 6h') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
    }
    const weighted = estimateRazzEquity(input, { iters: 4000, rng: mulberry32(5) })
    const uniform = estimateRazzEquity(input, {
      iters: 4000,
      rng: mulberry32(5),
      range: UNIFORM_RAZZ_RANGE,
    })
    expect(weighted.equity).toBeLessThan(uniform.equity)
  })

  it('入力検証: 枚数・重複・ジョーカー', () => {
    const base: RazzEquityInput = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('Kd') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
    }
    expect(() =>
      estimateRazzEquity({ ...base, heroDown: parseCards('Ah') }, { iters: 1 }),
    ).toThrow()
    expect(() =>
      estimateRazzEquity({ ...base, heroDown: parseCards('Ah 3c') }, { iters: 1 }),
    ).toThrow(/duplicate/)
    expect(() =>
      estimateRazzEquity({ ...base, heroDown: parseCards('Ah X1') }, { iters: 1 }),
    ).toThrow(/joker/)
    expect(() =>
      estimateRazzEquity(
        { ...base, seats: [{ up: parseCards('3c') }] },
        { iters: 1 },
      ),
    ).toThrow(/2-6/)
  })
})
