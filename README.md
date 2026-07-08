# Razz Solver

Razz（セブンカードスタッド・ローボール、A-5 ロー）のスポットソルバー。

- **A-5 ロー評価** — 参照実装と整数パック高速版（全数クロスチェック済み）
- **エクイティエンジン** — レンジ重み付けモンテカルロ（勝率・タイ率・7/8ロー到達率）
- **スポットソルバー** — 固定リミットの MCCFR。アクションごとの頻度と EV を出力
  - ヘッズアップ: リバーまでのフルツリー
  - 3人以上: 現在ストリートのみ + EQ 終端の近似解

UI は準備中。ソルバー本体は `src/domain/` にあり、`solveRazzSpot` がエントリポイント。

```ts
import { parseCards, solveRazzSpot } from './src/domain'

const result = solveRazzSpot({
  street: 3,
  seats: [{ up: parseCards('3c') }, { up: parseCards('Kd') }],
  heroIndex: 0,
  heroDown: parseCards('Ah 2s'),
  stakes: { ante: 1, bringIn: 2, smallBet: 4, bigBet: 8 },
})
// => { actions: [{ action: 'fold'|'call'|'complete'..., frequency, ev }], equity, ... }
```

## 開発

```sh
pnpm install
pnpm test    # vitest（MCCFR は Kuhn poker の解析解とクロスチェック）
pnpm build   # tsc -b && vite build
```
