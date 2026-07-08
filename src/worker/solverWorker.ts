// レンジグリッド解析を UI スレッド外で実行する Web Worker。
// MCCFR は重い（数秒〜数十秒）ので必ずこの Worker 経由で呼ぶ。

import {
  type RazzGridResult,
  type RazzGridSpot,
  solveRazzRangeGrid,
} from '../domain'

export interface SolveGridRequest {
  id: number
  spot: RazzGridSpot
  iterations: number
}

export type SolverResponse =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'result'; result: RazzGridResult }
  | { id: number; type: 'error'; message: string }

const post = (msg: SolverResponse) =>
  (self as unknown as { postMessage(m: SolverResponse): void }).postMessage(msg)

self.onmessage = (e: MessageEvent<SolveGridRequest>) => {
  const { id, spot, iterations } = e.data
  try {
    const result = solveRazzRangeGrid(spot, {
      iterations,
      onProgress: (done, total) => post({ id, type: 'progress', done, total }),
    })
    post({ id, type: 'result', result })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
