import { useState } from 'react'
import { type Lang, t } from './i18n'

// 実戦アシスタント UI は今後実装。現状はソルバーコア（src/domain/）のみ。
export default function App() {
  const [lang, setLang] = useState<Lang>('ja')
  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{t(lang, 'title')}</h1>
          <p className="subtitle">{t(lang, 'subtitle')}</p>
        </div>
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLang((l) => (l === 'ja' ? 'en' : 'ja'))}
        >
          {lang === 'ja' ? 'EN' : 'JA'}
        </button>
      </header>
      <section className="panel">
        <p className="hint">{t(lang, 'uiPending')}</p>
      </section>
    </main>
  )
}
