// i18n（ja/en）。文言はここに集約し、t(lang, key) 経由で使う。JSX に直書きしない。

export type Lang = 'ja' | 'en'

const messages = {
  title: { ja: 'Razz ソルバー', en: 'Razz Solver' },
  subtitle: {
    ja: 'セブンカードスタッド・ローボール（A-5）スポットソルバー',
    en: 'Seven-card stud lowball (A-5) spot solver',
  },
  players: { ja: '人数', en: 'Players' },
  position: { ja: 'Pos {n}', en: 'Pos {n}' },
  bringInBadge: { ja: 'BI', en: 'BI' },
  actionsLabel: { ja: 'アクション', en: 'Actions' },
  nextToAct: {
    ja: '次の手番: Pos {n}（{card}）',
    en: 'Next to act: Pos {n} ({card})',
  },
  potLabel: { ja: 'ポット {n}', en: 'Pot {n}' },
  toCallLabel: { ja: 'コール {n}', en: 'To call {n}' },
  undo: { ja: '1手戻す', en: 'Undo' },
  reset: { ja: 'リセット', en: 'Reset' },
  handOver: {
    ja: 'ハンド終了（1人を残して全員フォールド）',
    en: 'Hand over (everyone folded to one player)',
  },
  streetClosed: {
    ja: 'このストリートのベッティングは終了しました（続きの入力は非対応）',
    en: 'Betting on this street is closed (later streets not supported)',
  },
  staleResult: {
    ja: '入力が変更されています。「計算」で結果を更新してください。',
    en: 'Inputs have changed. Press Go to refresh the result.',
  },
  ante: { ja: 'アンティ', en: 'Ante' },
  bringInAmount: { ja: 'ブリングイン', en: 'Bring-in' },
  smallBet: { ja: 'スモールベット', en: 'Small bet' },
  bigBet: { ja: 'ビッグベット', en: 'Big bet' },
  precision: { ja: '精度', en: 'Precision' },
  presetFast: { ja: '速い', en: 'Fast' },
  presetStandard: { ja: '標準', en: 'Standard' },
  presetFine: { ja: '高精度', en: 'Fine' },
  presetExact: { ja: '最高精度（正確・重い）', en: 'Exact (slow)' },
  go: { ja: '計算', en: 'Go' },
  solving: { ja: '計算中… {pct}%', en: 'Solving… {pct}%' },
  nodeProgress: {
    ja: '計算中… ノード {i}/{k}（{pct}%）',
    en: 'Solving… node {i}/{k} ({pct}%)',
  },
  previous: { ja: '戻る', en: 'Previous' },
  actorTitle: {
    ja: 'Pos {n}（{card}）の戦略 — 3rd street',
    en: 'Strategy for Pos {n} ({card}) — 3rd street',
  },
  horizonRiver: {
    ja: 'リバーまでのフルツリー（HU）',
    en: 'Full tree to the river (HU)',
  },
  horizonStreet: {
    ja: '現在ストリートのみの近似（3人以上）',
    en: 'Current street only (3+ players, approximate)',
  },
  legendFold: { ja: 'フォールド', en: 'Fold' },
  legendCall: { ja: 'チェック/コール', en: 'Check/Call' },
  legendRaise: { ja: 'ベット/レイズ', en: 'Bet/Raise' },
  fold: { ja: 'フォールド', en: 'Fold' },
  check: { ja: 'チェック', en: 'Check' },
  call: { ja: 'コール', en: 'Call' },
  bet: { ja: 'ベット', en: 'Bet' },
  complete: { ja: 'コンプリート', en: 'Complete' },
  raise: { ja: 'レイズ', en: 'Raise' },
  combos: { ja: '{n} コンボ', en: '{n} combos' },
  errRank: {
    ja: 'Pos {n} のアップカードが不正です（A 2-9 T J Q K を入力）',
    en: 'Invalid upcard for Pos {n} (use A 2-9 T J Q K)',
  },
  errTooMany: {
    ja: '同じランクは 4 枚までです（{rank}）',
    en: 'At most 4 cards of the same rank ({rank})',
  },
  errStakes: {
    ja: 'ステークスが不正です（正の数、ブリングイン < スモールベット）',
    en: 'Invalid stakes (positive numbers, bring-in < small bet)',
  },
  noteAbstraction: {
    ja: 'ハンドはバケット抽象化されるため、同じバケットのセルは同じ戦略になります。スートは自動割り当てです。',
    en: 'Hands are bucket-abstracted, so cells in the same bucket share a strategy. Suits are auto-assigned.',
  },
  noteExact: {
    ja: '手番ストリートはランクペアごとに正確に計算しています（以降のストリートはバケット抽象化）。スートは自動割り当てです。',
    en: 'The current street is solved exactly per rank pair (later streets remain bucket-abstracted). Suits are auto-assigned.',
  },
  noteThreshold: {
    ja: '頻度5%未満のアクションは収束ノイズとして省略し、再正規化して表示しています。',
    en: 'Actions below 5% frequency are treated as convergence noise, dropped, and renormalized.',
  },
  noteLazyTree: {
    ja: '各プレイヤーのレンジは、経路上の判断ノードを解いた頻度で内生的に絞り込まれます（セルの濃さ＝到達確率）。訪問済みノードは再計算なしで即時表示されます。',
    en: 'Each player\'s range narrows endogenously using the solved frequencies at earlier decision nodes on the line (cell opacity = reach). Visited nodes redisplay instantly.',
  },
} as const

export type MessageKey = keyof typeof messages

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = messages[key][lang]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}
