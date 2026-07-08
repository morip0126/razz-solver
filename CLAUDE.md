# 開発メモ（Razz Solver）

Razz（セブンカードスタッド・ローボール、A-5 ロー）のスポットソルバー。Vite + React + TypeScript。
ofc-solver から独立させたリポジトリ。
重い計算を UI に載せるときは Web Worker で実行する（ofc-solver と同じ流儀）。

## UI（src/App.tsx + src/worker/solverWorker.ts）

- レンジグリッド UI（3rd street）: 各ポジションのアップカード（ランクのみ、スートは自動割り当て）
  と履歴文字列（f/c/r 等）を入力 → `solveRazzRangeGrid` を Worker で実行し、手番プレイヤーの
  伏せ札 2 枚の全 91 ランクペアの戦略を 13×13 三角グリッドで表示（青=fold 緑=check/call 赤=bet/raise）。
- 下部のアクションボタン（コンボ数加重の全体頻度つき）で履歴を進め、「戻る」で 1 手戻す。
  どちらも自動で再計算する。
- Worker は再計算のたびに terminate → 新規生成（キャンセル代わり）。進捗は
  `RazzSolveOptions.onProgress`（MCCFR 約1%刻み）経由でプログレスバーに反映。

## ビルド / 確認

- 本番ビルド: `pnpm build`（= `tsc -b && vite build`）。**push 前に必ず通す**。
- テスト: `pnpm test`（vitest、MCCFR・モンテカルロが重いので `--testTimeout=20000`）。
- UI を触ったらブラウザ（モバイル幅375px・デスクトップ）で実機確認する。横スクロールは最終手段。

## 作業の進め方

- **コミット / プッシュはユーザーが指示したときだけ**。勝手にやらない。
- **プッシュ前の順序**: `pnpm build` を通す → 必要ならブラウザ確認 → コミット → プッシュ。
- **コミットメッセージは英語1行**。
- **i18n は ja/en 両方**を必ず追加する（UI 実装時）。
- **用語の統一**: エクイティ/期待値の表示は EQ / EV。プレイヤー名は Hero / Villain。
- **数値検証**: エクイティ・ポット分配・確率が疑わしいときは、独立実装や決定論的テストでクロスチェックしてから結論を出す。

## ドメイン設計メモ（src/domain/）

- `cards.ts` / `combinatorics.ts`: ofc-solver 由来の共有ユーティリティ。カードは `{rank, suit}`
  （A=14。Razz 側で A=1 に変換）。モンテカルロは決定論的 PRNG（`mulberry32`）を注入して
  テストの再現性を確保する。ジョーカーの型は残っているが **Razz では非対応**（`razzRank` が拒否）。
- `razz.ts`: A-5 ロー評価。**小さいほど強い**。参照実装 `razzValue5`（`[カテゴリ, ...タイブレーカー]`
  の辞書式比較）と高速版 `razzKey5`（基数14の整数パック）の二本立てで、
  **`razz.test.ts` の全ランク多重集合クロスチェックを必ず維持する**。ベスト5枚は `razzBestKey`（5〜7枚）。
- `razzRange.ts`: 相手伏せ札のレンジ重み付けモデル（参加者は低札寄り・自ボードとのペア回避）。
  `lowBias=0` で一様に退化（`UNIFORM_RAZZ_RANGE`）。ホットパス用に `rankWeightTable` で重みを事前計算。
- `razzEquity.ts`: `estimateRazzEquity` = ショーダウン EQ のモンテカルロ。7ロー/8ロー到達確率も返す。
- `razzCfr.ts`: 汎用 MCCFR（external sampling）コア。ゲーム定義は `CfrGame` インターフェースで注入。
  **Kuhn poker の解析解（ゲーム値 -1/18、K は常にコール等）とのクロスチェックテスト
  （`razzCfr.test.ts`）を必ず維持する**。
- `razzGame.ts`: 固定リミットのスポットソルバー `solveRazzSpot`。出力 = アクションごとの頻度と EV
  （GTO Wizard 風）+ EQ。意図的な近似:
  - HU（ルート時点でアクティブ2人）はリバーまでのフルツリー、**3人以上は現在ストリートのみ +
    チェックダウン想定のショーダウン評価**（`horizon: 'street'`）。3人以上の CFR は均衡保証のない近似解。
  - ハンドはバケット抽象化（メイドの強さティア × 8以下の異なるランク数、`razzHandBucket`）。
    公開情報は相手ボードの粗いティア（`razzBoardTier`）。
  - 学習時は Hero の伏せ札もレンジからサンプル（公開情報ベースの均衡計算）。Hero の実ハンドの
    EV は学習後に実ハンドを固定したロールアウト（`estimateActionValues`）で推定。
  - スタック無限（オールインなし）。ブリングインは最高位アップカード（同ランクはスート c<d<h<s）。
- `solveRazzRangeGrid`（razzGame.ts）: レンジグリッド解析。Hero の実ハンドを固定せず、履歴後に
  手番となるプレイヤーの伏せ札 2 枚の全ランクペア（91 通り）の平均戦略とコンボ数を返す。
  バケット抽象化のため同一バケットのペアは同じ戦略になる。7th（伏せ札 3 枚）は非対応。
  履歴は `coerceRazzAction` で 1 文字表記（f/k/x/c/b/p/r）を局面の合法アクションへ解決する。
- 重い（HU 3rd street で既定パラメータ数十秒）ので UI に載せるときは Worker 経由で呼ぶこと。

## 注意

- ステークスは `{ante, bringIn, smallBet, bigBet, raiseCap}` をスポットごとに指定（ルーム差に対応）。
- `solveRazzSpot` の反復回数（`iterations` / `evalSamples` / `equityIters`）は精度と時間のトレードオフ。
  テストでは小さめ + `mulberry32` 固定シードで決定論的に。
