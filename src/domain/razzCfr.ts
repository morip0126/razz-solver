// 汎用 MCCFR（external sampling）コア。Razz スポットソルバーの均衡計算に使う。
// ゲーム定義は CfrGame インターフェースで注入する（razzCfr.test.ts では Kuhn poker で
// 既知の均衡に収束することを検証する）。2人ゲームでは均衡近似の理論保証があり、
// 3人以上では保証はないが実用的な近似戦略として用いる。
//
// vanilla MCCFR に対する高速化（理論的背景と実験は docs/solver-theory.md）:
// - 平均戦略の二次加重（DCFR γ=2、既定で有効）: 反復 t の寄与を t² に比例させ、学習初期の
//   一様分布が平均戦略に残る（純戦略のハンドに数%の別アクションが混ざる）のを防ぐ。
//   Razz 3rd street の実験で残留ノイズが 11%→1.6% に減少した。
// - regret-matching+（CFR+ / DCFR β=0、**既定で無効**）: external sampling と併用すると
//   サンプリング分散でリグレットが振動し、むしろ大幅に悪化した（文献の指摘どおり。
//   分散低減 = VR-MCCFR と併用して初めて機能する）。オプションとしてのみ残す。
// DCFR の正リグレット割引（α=1.5）は全ノード走査が必要になるため採用していない。

export interface CfrGame<TDeal, TState> {
  readonly numPlayers: number
  /** チャンス（配札）を 1 回サンプルする。 */
  sampleDeal(rng: () => number): TDeal
  /** ルート状態（同一オブジェクトの再利用可。遷移は非破壊であること）。 */
  initialState(deal: TDeal): TState
  isTerminal(state: TState): boolean
  /** 終端での player の利得。 */
  utility(state: TState, deal: TDeal, player: number): number
  currentPlayer(state: TState): number
  /** 手番プレイヤーの合法アクション（state のみに依存すること）。 */
  legalActions(state: TState): readonly string[]
  nextState(state: TState, deal: TDeal, action: string): TState
  /** 手番プレイヤーから見た情報集合キー。 */
  infosetKey(state: TState, deal: TDeal): string
}

export interface CfrNode {
  actions: readonly string[]
  regret: Float64Array
  strategySum: Float64Array
}

export interface CfrSolution {
  nodes: Map<string, CfrNode>
}

function getNode(sol: CfrSolution, key: string, actions: readonly string[]): CfrNode {
  let node = sol.nodes.get(key)
  if (!node) {
    node = {
      actions,
      regret: new Float64Array(actions.length),
      strategySum: new Float64Array(actions.length),
    }
    sol.nodes.set(key, node)
  }
  return node
}

/** regret matching による現在戦略（正のリグレットに比例、なければ一様）。 */
function currentStrategy(node: CfrNode): number[] {
  const n = node.actions.length
  const strategy = new Array<number>(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const r = node.regret[i] > 0 ? node.regret[i] : 0
    strategy[i] = r
    total += r
  }
  if (total <= 0) return strategy.fill(1 / n)
  for (let i = 0; i < n; i++) strategy[i] /= total
  return strategy
}

/** 確率ベクトルからインデックスを 1 つサンプルする。 */
export function sampleIndex(probs: readonly number[], rng: () => number): number {
  let threshold = rng()
  for (let i = 0; i < probs.length; i++) {
    threshold -= probs[i]
    if (threshold <= 0) return i
  }
  return probs.length - 1
}

function traverse<TDeal, TState>(
  game: CfrGame<TDeal, TState>,
  sol: CfrSolution,
  state: TState,
  deal: TDeal,
  traverser: number,
  rng: () => number,
  avgWeight: number,
  rmPlus: boolean,
): number {
  if (game.isTerminal(state)) return game.utility(state, deal, traverser)
  const actions = game.legalActions(state)
  if (actions.length === 1) {
    return traverse(
      game, sol, game.nextState(state, deal, actions[0]), deal, traverser, rng, avgWeight, rmPlus,
    )
  }
  const player = game.currentPlayer(state)
  const node = getNode(sol, game.infosetKey(state, deal), actions)
  const strategy = currentStrategy(node)

  if (player === traverser) {
    // 自分の手番: 全アクションを展開してリグレット更新（regret-matching+ でクリップ）
    const utils = new Array<number>(actions.length)
    let value = 0
    for (let i = 0; i < actions.length; i++) {
      utils[i] = traverse(
        game, sol, game.nextState(state, deal, actions[i]), deal, traverser, rng, avgWeight, rmPlus,
      )
      value += strategy[i] * utils[i]
    }
    if (rmPlus) {
      for (let i = 0; i < actions.length; i++) {
        node.regret[i] = Math.max(0, node.regret[i] + utils[i] - value)
      }
    } else {
      for (let i = 0; i < actions.length; i++) node.regret[i] += utils[i] - value
    }
    return value
  }

  // 相手の手番: 平均戦略を反復加重つきで蓄積し、現在戦略から 1 アクションをサンプル
  for (let i = 0; i < actions.length; i++) node.strategySum[i] += avgWeight * strategy[i]
  const idx = sampleIndex(strategy, rng)
  return traverse(
    game, sol, game.nextState(state, deal, actions[idx]), deal, traverser, rng, avgWeight, rmPlus,
  )
}

export interface McCfrOptions {
  iterations: number
  rng?: () => number
  /** 学習の進捗通知（約1%刻み）。Web Worker から UI へ進捗を返すために使う。 */
  onProgress?: (done: number, total: number) => void
  /** regret-matching+（負の累積リグレットをクリップ）。既定 false。 */
  regretMatchingPlus?: boolean
  /** 平均戦略の反復加重の指数（DCFR の γ。0 = 一様平均）。既定 2。 */
  averagingExponent?: number
}

/** external sampling MCCFR を実行し、蓄積した解を返す。 */
export function runMccfr<TDeal, TState>(
  game: CfrGame<TDeal, TState>,
  opts: McCfrOptions,
): CfrSolution {
  const rng = opts.rng ?? Math.random
  const sol: CfrSolution = { nodes: new Map() }
  const step = opts.onProgress ? Math.max(1, Math.ceil(opts.iterations / 100)) : 0
  const gamma = opts.averagingExponent ?? 2
  const rmPlus = opts.regretMatchingPlus ?? false
  for (let it = 0; it < opts.iterations; it++) {
    const avgWeight = gamma === 0 ? 1 : (it + 1) ** gamma
    for (let p = 0; p < game.numPlayers; p++) {
      const deal = game.sampleDeal(rng)
      traverse(game, sol, game.initialState(deal), deal, p, rng, avgWeight, rmPlus)
    }
    if (step && ((it + 1) % step === 0 || it + 1 === opts.iterations)) {
      opts.onProgress!(it + 1, opts.iterations)
    }
  }
  return sol
}

/** 平均戦略（未訪問の情報集合は一様）。 */
export function averageStrategy(sol: CfrSolution, key: string, nActions: number): number[] {
  const node = sol.nodes.get(key)
  if (!node) return new Array<number>(nActions).fill(1 / nActions)
  let total = 0
  for (let i = 0; i < node.strategySum.length; i++) total += node.strategySum[i]
  if (total <= 0) return new Array<number>(nActions).fill(1 / nActions)
  return [...node.strategySum].map((s) => s / total)
}

export interface ActionValue {
  action: string
  ev: number
}

/**
 * ルート（player の手番であること）の各アクションの EV を、
 * 全員が平均戦略に従うロールアウトで推定する。同一の配札を全アクションで
 * 使い回して分散を抑える。sampleDeal は game のものを使う（Razz では
 * Hero の実ハンドを固定した評価用ゲームを渡す）。
 */
export function estimateActionValues<TDeal, TState>(
  game: CfrGame<TDeal, TState>,
  sol: CfrSolution,
  opts: { player: number; samples: number; rng?: () => number },
): ActionValue[] {
  const rng = opts.rng ?? Math.random
  const probe = game.initialState(game.sampleDeal(rng))
  if (game.currentPlayer(probe) !== opts.player) {
    throw new Error('estimateActionValues: root is not the target player to act')
  }
  const actions = game.legalActions(probe)
  const totals = new Float64Array(actions.length)
  for (let s = 0; s < opts.samples; s++) {
    const deal = game.sampleDeal(rng)
    const root = game.initialState(deal)
    for (let i = 0; i < actions.length; i++) {
      let state = game.nextState(root, deal, actions[i])
      while (!game.isTerminal(state)) {
        const acts = game.legalActions(state)
        const sigma = averageStrategy(sol, game.infosetKey(state, deal), acts.length)
        state = game.nextState(state, deal, acts[sampleIndex(sigma, rng)])
      }
      totals[i] += game.utility(state, deal, opts.player)
    }
  }
  return actions.map((action, i) => ({ action, ev: totals[i] / opts.samples }))
}
