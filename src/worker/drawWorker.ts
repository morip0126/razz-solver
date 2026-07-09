// NL 2-7 シングルドローの一括ソルブ + ノード照会を UI スレッド外で実行する Worker。
// 解（DrawTreeSolution）を Worker 内に保持し、query は再計算なしで応答する。

import { mulberry32 } from '../domain/combinatorics'
import {
  type DrawConfig,
  type DrawNode,
  queryDrawTree,
  solveDrawTree,
  type DrawTreeSolution,
} from '../domain/drawGame'

export type DrawWorkerRequest =
  | { type: 'solve'; id: number; config: DrawConfig; iterations: number }
  | { type: 'query'; id: number; tokens: string }

export type DrawWorkerResponse =
  | { id: number; type: 'progress'; done: number; total: number }
  | { id: number; type: 'ready' }
  | { id: number; type: 'node'; tokens: string; node: DrawNode }
  | { id: number; type: 'error'; message: string }

const post = (msg: DrawWorkerResponse) =>
  (self as unknown as { postMessage(m: DrawWorkerResponse): void }).postMessage(msg)

let tree: DrawTreeSolution | null = null

self.onmessage = (e: MessageEvent<DrawWorkerRequest>) => {
  const req = e.data
  try {
    if (req.type === 'solve') {
      tree = solveDrawTree(req.config, {
        iterations: req.iterations,
        onProgress: (done, total) => post({ id: req.id, type: 'progress', done, total }),
      })
      post({ id: req.id, type: 'ready' })
      return
    }
    if (!tree) throw new Error('draw: solve first')
    // 照会サンプルは固定シード（同じノードは常に同じ表示になる）
    const node = queryDrawTree(tree, req.tokens, { samples: 20000, rng: mulberry32(0xd7a3) })
    post({ id: req.id, type: 'node', tokens: req.tokens, node })
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
