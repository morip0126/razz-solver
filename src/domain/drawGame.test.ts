// NL 2-7 シングルドロー（HU）のテスト。
// ベッティング遷移の正確性・決定論性・定性的な均衡の性質を検証する。

import { describe, expect, it } from 'vitest'
import { parseCards } from './cards'
import { mulberry32 } from './combinatorics'
import {
  bestKeep,
  describeBucket,
  patTier,
  postBucket,
  preBucket,
  queryDrawTree,
  replayDrawHistory,
  solveDrawTree,
} from './drawGame'

const CFG = { stackBb: 100 }

describe('replayDrawHistory', () => {
  it('プリドロー: BTN の合法アクションとポットレイズ額（3bb オープン）', () => {
    const r = replayDrawHistory(CFG, '')
    expect(r.actorIndex).toBe(0)
    expect(r.phase).toBe('pre')
    expect(r.legal.map((a) => a.token)).toEqual(['f', 'c', 'r', 'a'])
    expect(r.legal.find((a) => a.kind === 'raise')!.toAmount).toBe(3)
    expect(r.pot).toBe(1.5)
    expect(r.toCall).toBe(0.5)
  })

  it('レイズ合戦の額とドロー・ポストドローへの遷移', () => {
    // BTN 3bb → BB のポット3ベットは 9bb
    const r1 = replayDrawHistory(CFG, 'r')
    expect(r1.actorIndex).toBe(1)
    expect(r1.legal.find((a) => a.kind === 'raise')!.toAmount).toBe(9)
    // r c でプリドロー終了 → BB からドロー
    const r2 = replayDrawHistory(CFG, 'rc')
    expect(r2.phase).toBe('draw')
    expect(r2.actorIndex).toBe(1)
    expect(r2.legal.map((a) => a.token)).toEqual(['0', '1', '2'])
    // 両者ドロー → ポストドローは BB から
    const r3 = replayDrawHistory(CFG, 'rc10')
    expect(r3.phase).toBe('post')
    expect(r3.actorIndex).toBe(1)
    expect(r3.pot).toBe(6)
    // ポストのポットベットは 6bb 上乗せ → コミット 9
    expect(r3.legal.find((a) => a.kind === 'raise')!.toAmount).toBe(9)
  })

  it('フォールドとオールインの終了処理', () => {
    expect(replayDrawHistory(CFG, 'f').done).toBe(true)
    expect(replayDrawHistory(CFG, 'f').foldWin).toBe(true)
    // オールイン → コール → 両者ドローで終了（ポストドローのベッティングなし）
    const r = replayDrawHistory(CFG, 'rac12')
    expect(r.done).toBe(true)
    expect(r.foldWin).toBe(false)
    expect(r.pot).toBe(200)
    // 終了後の入力は invalidAt
    expect(replayDrawHistory(CFG, 'ff').invalidAt).toBe(1)
  })
})

describe('buckets', () => {
  it('パットティアとドロー質', () => {
    expect(patTier(parseCards('7c 5d 4h 3s 2c'))).toBe(0)
    expect(patTier(parseCards('Jc 8d 6h 4s 2c'))).toBe(4)
    expect(patTier(parseCards('6c 5d 4h 3s 2c'))).toBe(7) // ストレートは役なし扱い
    // 2-3-4-7 を残す 1 枚ドロー（K を捨てる）
    const keep = bestKeep(parseCards('Kc 7d 4h 3s 2c'), 4)
    expect(keep.map((c) => c.rank).sort((a, b) => a - b)).toEqual([2, 3, 4, 7])
    // ペアは崩す
    const keep2 = bestKeep(parseCards('7c 7d 4h 3s 2c'), 4)
    expect(new Set(keep2.map((c) => c.rank)).size).toBe(4)
  })

  it('ポストドローバケットの順序', () => {
    expect(postBucket(parseCards('7c 5d 4h 3s 2c'))).toBe(0) // ナッツ
    expect(postBucket(parseCards('8c 6d 4h 3s 2c'))).toBe(2) // 8 スムーズ
    expect(postBucket(parseCards('Tc 7d 6h 4s 2c'))).toBe(6) // T スムーズ
    expect(postBucket(parseCards('Ac 8d 6h 4s 2c'))).toBe(11) // A ロー
    expect(postBucket(parseCards('2c 2d 4h 5s 7c'))).toBe(12) // ペア
    expect(postBucket(parseCards('6c 5d 4h 3s 2c'))).toBe(13) // ストレート
    expect(describeBucket(0, 'post').pat).toBe('75432')
  })

  it('プリドローの細分化: スムーズ/ラフと引き目危険', () => {
    // パット 75432 = 7s、76432 = 7r
    expect(describeBucket(preBucket(parseCards('7c 5d 4h 3s 2c')), 'pre').pat).toBe('7s')
    expect(describeBucket(preBucket(parseCards('7c 6d 4h 3s 2c')), 'pre').pat).toBe('7r')
    // K7654 → 4567 キープは 1 枚でストレート完成があり得る（3/8）→ 危険フラグ
    const risky = describeBucket(preBucket(parseCards('Kc 7d 6h 5s 4c')), 'pre')
    expect(risky.draw1).toBe('7')
    expect(risky.draw1Risky).toBe(true)
    // K7642 → 2467 キープは危険なし
    const safe = describeBucket(preBucket(parseCards('Kc 7d 6h 4s 2c')), 'pre')
    expect(safe.draw1Risky).toBe(false)
    // 同ランクで 4 フラッシュを避けられるならスートを選ぶ（7642 に h と c の 7）
    const keep = bestKeep(parseCards('7c 6c 4c 2c 7h'), 4)
    expect(new Set(keep.map((c) => c.suit)).size).toBeGreaterThan(1)
  })
})

describe('solveDrawTree / queryDrawTree', () => {
  it('定性: パット7ローは降りず、ゴミはフォールド優位。決定論的', () => {
    const tree = solveDrawTree(CFG, { iterations: 40000, rng: mulberry32(11) })
    const root = queryDrawTree(tree, '', { samples: 8000, rng: mulberry32(12) })
    expect(root.actorIndex).toBe(0)
    expect(root.actions.map((a) => a.token)).toEqual(['f', 'c', 'r', 'a'])
    expect(root.totals.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6)
    expect(root.rows.length).toBeGreaterThan(10)

    const rowOf = (pred: (b: number) => boolean) => root.rows.find((r) => pred(r.bucket))
    const foldIdx = root.actions.findIndex((a) => a.kind === 'fold')
    // パット 7〜9 ロー（patDetail ≤ 5）はほぼ降りない
    const strong = rowOf((b) => Math.floor(b / 40) <= 5)
    expect(strong).toBeDefined()
    expect(strong!.freqs[foldIdx]).toBeLessThan(0.15)
    // 役なし・ドロー質最悪（J+ キープのみ）はフォールド優位
    const trash = rowOf(
      (b) => Math.floor(b / 40) === 11 && Math.floor(b / 4) % 10 >= 8 && b % 4 === 3,
    )
    if (trash) expect(trash.freqs[foldIdx]).toBeGreaterThan(0.5)

    // 決定論性
    const tree2 = solveDrawTree(CFG, { iterations: 3000, rng: mulberry32(11) })
    const tree3 = solveDrawTree(CFG, { iterations: 3000, rng: mulberry32(11) })
    const q2 = queryDrawTree(tree2, 'r', { samples: 2000, rng: mulberry32(5) })
    const q3 = queryDrawTree(tree3, 'r', { samples: 2000, rng: mulberry32(5) })
    expect(q2).toEqual(q3)
  }, 120000)

  it('ドローノードとポストドローの照会', () => {
    const tree = solveDrawTree(CFG, { iterations: 20000, rng: mulberry32(21) })
    const draw = queryDrawTree(tree, 'rc', { samples: 6000, rng: mulberry32(22) })
    expect(draw.phase).toBe('draw')
    expect(draw.actions.map((a) => a.count)).toEqual([0, 1, 2])
    expect(draw.totals.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6)

    const post = queryDrawTree(tree, 'rc11', { samples: 6000, rng: mulberry32(23) })
    expect(post.phase).toBe('post')
    expect(post.actorIndex).toBe(1)
    // ステップ頻度が全ステップで埋まる
    expect(post.steps).toHaveLength(4)
    for (const s of post.steps) {
      expect(s.freq).toBeGreaterThan(0)
      expect(s.freq).toBeLessThanOrEqual(1)
    }
    // ポストのナッツ級（75432）は降りない
    const foldIdx = post.actions.findIndex((a) => a.kind === 'fold')
    const nuts = post.rows.find((r) => r.bucket === 0)
    if (nuts && foldIdx >= 0) expect(nuts.freqs[foldIdx]).toBeLessThan(0.1)
  }, 120000)
})
