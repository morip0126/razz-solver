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
  history: { ja: '履歴', en: 'History' },
  historyHint: {
    ja: 'f=フォールド c=コール/チェック r=レイズ/コンプリート（例: ffffr）',
    en: 'f=fold c=call/check r=raise/complete (e.g. ffffr)',
  },
  ante: { ja: 'アンティ', en: 'Ante' },
  bringInAmount: { ja: 'ブリングイン', en: 'Bring-in' },
  smallBet: { ja: 'スモールベット', en: 'Small bet' },
  bigBet: { ja: 'ビッグベット', en: 'Big bet' },
  precision: { ja: '精度', en: 'Precision' },
  presetFast: { ja: '速い', en: 'Fast' },
  presetStandard: { ja: '標準', en: 'Standard' },
  presetFine: { ja: '高精度', en: 'Fine' },
  go: { ja: '計算', en: 'Go' },
  solving: { ja: '計算中… {pct}%', en: 'Solving… {pct}%' },
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
} as const

export type MessageKey = keyof typeof messages

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = messages[key][lang]
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}
