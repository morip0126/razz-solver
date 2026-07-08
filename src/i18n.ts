// i18n（ja/en）。文言はここに集約し、t(lang, key) 経由で使う。JSX に直書きしない。

export type Lang = 'ja' | 'en'

const messages = {
  title: { ja: 'Razz ソルバー', en: 'Razz Solver' },
  subtitle: {
    ja: 'セブンカードスタッド・ローボール（A-5）スポットソルバー',
    en: 'Seven-card stud lowball (A-5) spot solver',
  },
  uiPending: {
    ja: 'UI は準備中です。ソルバー本体（MCCFR・エクイティ計算）は src/domain/ に実装済みです。',
    en: 'UI is under construction. The solver core (MCCFR, equity engine) lives in src/domain/.',
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
