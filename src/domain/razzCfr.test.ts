// MCCFR コアの正しさを Kuhn poker（解析解が既知の最小ポーカー）で検証する。
// 均衡の性質: ゲーム値 = -1/18（先手が不利）、K でベットに直面したら常にコール、
// J でベットに直面したら常にフォールド、など。

import { describe, expect, it } from 'vitest'
import { mulberry32 } from './combinatorics'
import {
  type CfrGame,
  averageStrategy,
  estimateActionValues,
  runMccfr,
  sampleIndex,
} from './razzCfr'

// カード: 0=J, 1=Q, 2=K。履歴: k=チェック, b=ベット, c=コール, f=フォールド。
type KuhnDeal = [number, number]

const TERMINAL = new Set(['kk', 'bc', 'bf', 'kbc', 'kbf'])

const KUHN: CfrGame<KuhnDeal, string> = {
  numPlayers: 2,
  sampleDeal(rng) {
    const cards = [0, 1, 2]
    const i = Math.floor(rng() * 3)
    const a = cards.splice(i, 1)[0]
    const j = Math.floor(rng() * 2)
    return [a, cards[j]] as KuhnDeal
  },
  initialState: () => '',
  isTerminal: (h) => TERMINAL.has(h),
  utility(h, deal, player) {
    const showdown = (stake: number) => {
      const winner = deal[0] > deal[1] ? 0 : 1
      return player === winner ? stake : -stake
    }
    if (h === 'kk') return showdown(1)
    if (h === 'bc' || h === 'kbc') return showdown(2)
    // フォールド: 'bf' は P1 のベットに P2 が降りた、'kbf' は P2 のベットに P1 が降りた
    const bettor = h === 'bf' ? 0 : 1
    return player === bettor ? 1 : -1
  },
  currentPlayer: (h) => h.length % 2,
  legalActions(h) {
    if (h === '' || h === 'k') return ['k', 'b']
    return ['f', 'c'] // ベットに直面
  },
  nextState: (h, _deal, a) => h + a,
  infosetKey: (h, deal) => `${deal[h.length % 2]}|${h}`,
}

describe('runMccfr (Kuhn poker)', () => {
  const rng = mulberry32(2024)
  const sol = runMccfr(KUHN, { iterations: 120000, rng })

  it('K でベットに直面したらほぼ常にコール、J ならほぼ常にフォールド', () => {
    const kCall = averageStrategy(sol, '2|b', 2)
    expect(kCall[1]).toBeGreaterThan(0.95) // ['f','c'] の c
    const jFold = averageStrategy(sol, '0|b', 2)
    expect(jFold[0]).toBeGreaterThan(0.95)
    // チェック→ベットに直面する側も同様
    const kCall2 = averageStrategy(sol, '2|kb', 2)
    expect(kCall2[1]).toBeGreaterThan(0.95)
    const jFold2 = averageStrategy(sol, '0|kb', 2)
    expect(jFold2[0]).toBeGreaterThan(0.95)
  })

  it('P1 は Q でほぼベットしない', () => {
    const qBet = averageStrategy(sol, '1|', 2)
    expect(qBet[1]).toBeLessThan(0.1) // ['k','b'] の b
  })

  it('P2 は K でチェックに直面したらほぼ常にベット', () => {
    const kBet = averageStrategy(sol, '2|k', 2)
    expect(kBet[1]).toBeGreaterThan(0.95)
  })

  it('ゲーム値 ≈ -1/18（P1 視点、両者が平均戦略でプレイ）', () => {
    const playRng = mulberry32(7)
    const samples = 200000
    let total = 0
    for (let s = 0; s < samples; s++) {
      const deal = KUHN.sampleDeal(playRng)
      let state = KUHN.initialState(deal)
      while (!KUHN.isTerminal(state)) {
        const actions = KUHN.legalActions(state)
        const sigma = averageStrategy(sol, KUHN.infosetKey(state, deal), actions.length)
        state = KUHN.nextState(state, deal, actions[sampleIndex(sigma, playRng)])
      }
      total += KUHN.utility(state, deal, 0)
    }
    const value = total / samples
    expect(value).toBeGreaterThan(-1 / 18 - 0.02)
    expect(value).toBeLessThan(-1 / 18 + 0.02)
  })

  it('estimateActionValues: K を持つ P1 のベット EV はチェック EV 以上', () => {
    // Hero のカードを K に固定した評価用ゲーム（Razz の実ハンド固定評価と同じ流儀）
    const fixedGame: typeof KUHN = {
      ...KUHN,
      sampleDeal(rng) {
        return [2, Math.floor(rng() * 2)] as KuhnDeal // P1=K, P2=J or Q
      },
    }
    const values = estimateActionValues(fixedGame, sol, {
      player: 0,
      samples: 50000,
      rng: mulberry32(9),
    })
    const byAction = Object.fromEntries(values.map((v) => [v.action, v.ev]))
    // K は最強なので EV は正、かつベット（バリュー）がチェック以上
    expect(byAction.b).toBeGreaterThan(0.9)
    expect(byAction.b).toBeGreaterThanOrEqual(byAction.k - 0.02)
  })
})
