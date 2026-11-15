# JARVIS Video Workflow

株式会社OneのJARVISに追加する、動画制作専用の独立モジュールです。既存のLINE AI本体（リポジトリ直下の `server.js`）や日報機能は変更しません。

## 対象チャンネル
- YouTube: 時をかける日本史
- 編集環境: Windows版CapCut（外部連携は別途確認）
- 分析: Metricool（接続済みアカウントのAPI権限・利用可能操作を確認してから接続）

## 制作工程
1. planned — 企画
2. scripted — 台本完成
3. assets_ready — 音声・画像素材完成
4. edited — 編集完了
5. published — YouTube投稿済み
6. analyzed — 分析完了

## 現在の実装
`workflow.js` は動画ジョブの入力検証と工程遷移を行う純粋なNode.jsモジュールです。状態はまだメモリにも外部DBにも保存しません。JARVIS APIへの接続、永続化、AI台本生成、音声・画像生成、CapCut操作、YouTube投稿、Metricool分析は、認証方式と実行権限を確認してから段階的に追加します。

## 安全方針
- この段階では外部サービスへの投稿・変更を実行しません。
- OAuthトークンやAPIキーをソースコードへ保存しません。
- YouTube投稿はユーザーの明示承認を必須にする設計とします。
- 既存のLINE AI本番コードとGoogle Sheetsの日報データには触れません。

## テスト
`cd jarvis && npm test`
