# JARVIS Video Workflow

株式会社OneのJARVISに追加する、動画制作専用の独立モジュールです。既存のLINE AI本体（リポジトリ直下の `server.js`）や日報機能は変更しません。

## 対象チャンネル
- YouTube: 時をかける日本史
- 編集エンジン: Descript / Agent Underlord（ChatGPT連携経由）
- Hinata音声: vidIQ Voiceoverで生成し、MP3をDescriptへ渡す設計
- CapCut: 原則使わず、必要時の手動仕上げ用
- 分析: Metricool（接続済みアカウントのAPI権限・利用可能操作を確認してから接続）

## 制作工程
1. planned — 企画
2. scripted — 台本完成
3. assets_ready — Hinata音声・画像・映像素材完成
4. edited — Descript / Agent Underlordで編集完了
5. published — YouTube投稿済み
6. analyzed — 分析完了

## 標準ナレーション設定
- Provider: vidIQ AI Voiceover
- Voice: Hinata（日本語・男性・落ち着いた語り）
- Voice ID: `j210dv0vWm7fCknyQpbA`
- 出力形式: MP3

この設定は動画ジョブの初期値として保存します。ChatGPT内で利用できるvidIQ音声生成機能があることは確認済みです。JARVISサーバーから直接生成するには別途API認証が必要です。

## Descript連携方針
DescriptのAgent UnderlordはChatGPT連携からプロジェクト作成・編集・書き出しを操作できます。現状、この接続はChatGPT側のツールとして提供されており、JARVISサーバーから同じ接続を直接呼び出せるAPI資格情報は確認できていません。したがって、JARVISの動画ジョブ管理とChatGPT側のDescript実行を分離し、公開前の承認ゲートを設けます。Descript側のAIクレジット不足により、テンプレートプロジェクト作成は現時点で未完了です。

## 現在の実装
`workflow.js` は動画ジョブの入力検証と工程遷移を行う純粋なNode.jsモジュールです。状態の永続化、JARVIS APIへの接続、AI台本生成、音声・画像生成、Descript実行の自動ブリッジ、YouTube投稿、Metricool分析は未実装です。各サービスのAPI認証・利用権限を確認して段階的に追加します。

## 安全方針
- この段階では外部サービスへの投稿・変更を実行しません。
- OAuthトークンやAPIキーをソースコードへ保存しません。
- YouTube投稿はユーザーの明示承認を必須にする設計とします。
- 既存のLINE AI本番コードとGoogle Sheetsの日報データには触れません。

## テスト
`cd jarvis && npm test`
