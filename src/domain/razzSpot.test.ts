// Razz スポットソルバーの結合テスト。
// 厳密解との比較は不可能なので、明確に正解が分かるスポット（ナッツ/ドローデッド）での
// 定性的な性質と、決定論的な再現性を検証する。

import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import {
  type RazzSpot,
  razzBringInIndex,
  razzHandBucket,
  solveRazzSpot,
} from './razzGame'

const STAKES = { ante: 1, bringIn: 2, smallBet: 4, bigBet: 8 }

function advice(result: ReturnType<typeof solveRazzSpot>, action: string) {
  const a = result.actions.find((x) => x.action === action)
  if (!a) throw new Error(`action ${action} not offered: ${result.actions.map((x) => x.action)}`)
  return a
}

describe('solveRazzSpot', () => {
  it('7th HU: ホイール（ナッツ）でベットに直面 → フォールドせず、レイズ EV > コール EV > 0', () => {
    // Hero ボード [3,4,5,K] vs 相手ボード [6,8,9,T]（相手が先に act してベット）
    const spot: RazzSpot = {
      street: 7,
      seats: [{ up: parseCards('3c 4d 5h Ks') }, { up: parseCards('6c 8d 9h Td') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2c 7s'),
      stakes: STAKES,
      pot: 26,
      actionsSoFar: ['bet'],
    }
    const r = solveRazzSpot(spot, { iterations: 6000, evalSamples: 4000, rng: mulberry32(1) })
    expect(r.horizon).toBe('river')
    expect(r.equity).toBeGreaterThan(0.95)
    expect(advice(r, 'fold').ev).toBe(0)
    expect(advice(r, 'call').ev).toBeGreaterThan(0)
    expect(advice(r, 'raise').ev).toBeGreaterThan(advice(r, 'call').ev)
    expect(advice(r, 'fold').frequency).toBeLessThan(0.1)
  })

  it('7th HU: 勝ち目のないハンドでベットに直面 → コール EV は負', () => {
    // Hero は Q ペア以下が作れない（K/Q/J/T のペアだらけ）、相手は低ボード
    const spot: RazzSpot = {
      street: 7,
      seats: [{ up: parseCards('Kc Qd Jh Ts') }, { up: parseCards('2c 4d 6h 8s') }],
      heroIndex: 0,
      heroDown: parseCards('Kh Kd Qs'),
      stakes: STAKES,
      pot: 26,
      actionsSoFar: ['bet'],
    }
    const r = solveRazzSpot(spot, { iterations: 6000, evalSamples: 4000, rng: mulberry32(2) })
    expect(r.equity).toBeLessThan(0.15)
    expect(advice(r, 'call').ev).toBeLessThan(0)
    expect(advice(r, 'fold').ev).toBe(0)
  })

  it('3rd HU: (A-2)/3 は K のブリングインに対してほぼ降りない', () => {
    // seats[1] の K が自動的にブリングイン → hero が最初のアクション
    const spot: RazzSpot = {
      street: 3,
      seats: [{ up: parseCards('3c') }, { up: parseCards('Kd') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
      stakes: STAKES,
    }
    const r = solveRazzSpot(spot, { iterations: 5000, evalSamples: 3000, rng: mulberry32(3) })
    expect(r.horizon).toBe('river')
    const fold = advice(r, 'fold')
    const complete = advice(r, 'complete')
    expect(fold.frequency).toBeLessThan(0.2)
    expect(complete.ev).toBeGreaterThan(0)
    // アクションは fold / call / complete の 3 択
    expect(r.actions.map((a) => a.action).sort()).toEqual(['call', 'complete', 'fold'])
  })

  it('マルチウェイ（3人）は現在ストリートのみの近似で解く', () => {
    const spot: RazzSpot = {
      street: 5,
      seats: [
        { up: parseCards('2c 5d 7h') },
        { up: parseCards('4c 6d 8h') },
        { up: parseCards('3s 9c Jd') },
      ],
      heroIndex: 0,
      heroDown: parseCards('Ah 3d'),
      stakes: STAKES,
      pot: 30,
    }
    const r = solveRazzSpot(spot, { iterations: 16000, evalSamples: 8000, rng: mulberry32(9) })
    expect(r.horizon).toBe('street')
    // Hero のボードが最も低いので Hero が先頭 → check/bet の 2 択
    expect(r.actions.map((a) => a.action)).toEqual(['check', 'bet'])
    const freqSum = r.actions.reduce((x, a) => x + a.frequency, 0)
    expect(freqSum).toBeCloseTo(1, 6)
    // 最強ボード + 好ハンド。このモデルではチェック（レイズ狙い）優位だが、
    // ベット EV がチェックを大きく下回ることはないはず
    expect(advice(r, 'bet').ev).toBeGreaterThan(advice(r, 'check').ev - 3)
  }, 120000)

  it('同一シードで決定論的に再現する', () => {
    const spot: RazzSpot = {
      street: 7,
      seats: [{ up: parseCards('3c 4d 5h Ks') }, { up: parseCards('6c 8d 9h Td') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2c 7s'),
      stakes: STAKES,
      pot: 26,
      actionsSoFar: ['bet'],
    }
    const opts = { iterations: 1500, evalSamples: 800 }
    const a = solveRazzSpot(spot, { ...opts, rng: mulberry32(5) })
    const b = solveRazzSpot(spot, { ...opts, rng: mulberry32(5) })
    expect(a).toEqual(b)
  })

  it('入力検証: 4th 以降はポット必須、履歴が Hero の手番で終わらないとエラー', () => {
    const base: RazzSpot = {
      street: 4,
      seats: [{ up: parseCards('3c 4d') }, { up: parseCards('Kd 2h') }],
      heroIndex: 0,
      heroDown: parseCards('Ah 2s'),
      stakes: STAKES,
      pot: 10,
    }
    expect(() => solveRazzSpot({ ...base, pot: undefined })).toThrow(/pot/)
    // 4th は Hero ボード（3,4）が最低 → Hero が先頭。check を挟むと相手の手番になる
    expect(() =>
      solveRazzSpot({ ...base, actionsSoFar: ['check'] }, { iterations: 10, evalSamples: 10 }),
    ).toThrow(/turn|hero/)
    // ブリングインより小さいコンプリートは不正なステークス
    expect(() =>
      solveRazzSpot({ ...base, stakes: { ...STAKES, bringIn: 4 } }),
    ).toThrow(/bringIn/)
  })
})

describe('razzBringInIndex / razzHandBucket', () => {
  it('最高位のアップカードがブリングイン（A はロー）', () => {
    expect(
      razzBringInIndex([{ up: parseCards('Ah') }, { up: parseCards('Kd') }, { up: parseCards('Qs') }]),
    ).toBe(1)
    // 同ランクはスート順（c<d<h<s）で高い方
    expect(razzBringInIndex([{ up: parseCards('Kc') }, { up: parseCards('Ks') }])).toBe(1)
  })

  it('ハンドバケットはメイドの強さと低札数を反映する', () => {
    const wheel = razzHandBucket(parseCards('Ah 2c 3d 4s 5h'))
    const rough = razzHandBucket(parseCards('9h Tc Jd Qs Kh'))
    const draw = razzHandBucket(parseCards('Ah 2c 3d'))
    const pairedDraw = razzHandBucket(parseCards('Ah Ac 3d'))
    expect(wheel).toBeLessThan(rough)
    expect(draw).toBeLessThan(pairedDraw) // ペアなしドローの方がティアが低い（強い）
  })
})
