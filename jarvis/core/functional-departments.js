"use strict";

// Functional ownership matrix. This intentionally layers on top of the legacy
// agent registry so existing department IDs and handlers remain compatible.
const BASE_PERMISSIONS=Object.freeze({
  read:true,analyze:true,draft:true,internalTask:true,
  externalSubmit:false,financialCommit:false,publish:false,delete:false,permissionChange:false,
  approvalRequiredForExternalEffects:true
});
const DEPARTMENTS=Object.freeze([
 {id:"management",name:"経営・管理",legacyAgentIds:["management","jarvis"],mission:"経営計画、KPI、資金繰りの論点整理と経営判断資料の作成",inputs:["経営目標","売上・原価・資金繰り集計","各部門の進捗"],outputs:["経営ダッシュボード案","KPI異常レポート","意思決定案"],tools:["Task Registry","Command Center","Company Analytics"],audit:["根拠データ期間","計算式・前提","判断案と承認者"]},
 {id:"finance-accounting",name:"財務・会計",legacyAgentIds:["tax"],mission:"売上・経費・請求・入金・税務資料の照合と月次会計の下書き",inputs:["売上・経費・外注費","請求・入金","証憑メタデータ"],outputs:["月次集計案","未収・未払一覧","税務資料下書き"],tools:["Company Sheets read-only adapter","Financial Analytics","Task Registry"],audit:["元データ行識別子","集計期間","差異・未確認項目","確定操作の承認記録"]},
 {id:"sales",name:"営業",legacyAgentIds:[],mission:"見込み顧客、案件、商談、受注確度の整理と営業提案の下書き",inputs:["問い合わせ","案件履歴","顧客指定条件"],outputs:["案件パイプライン","提案書下書き","フォローアップ案"],tools:["Task Registry","CRM adapter when configured"],audit:["情報取得元","顧客情報アクセス理由","対外送信の承認"]},
 {id:"construction",name:"建設・施工管理",legacyAgentIds:["construction"],mission:"現場工程、施工体制、日報、進捗、原価、安全上の注意点を整理",inputs:["現場台帳","日報","工程・施工条件","作業員・機材情報"],outputs:["工程案","日報要約","現場課題・是正案"],tools:["Company Sheets read-only adapter","Task Registry"],audit:["対象現場","対象日","現場責任者確認","安全上の未確定事項"]},
 {id:"estimating",name:"見積・積算",legacyAgentIds:["construction","procurement"],mission:"数量、歩掛、材料・労務・機械費を根拠付きで積算し見積案を作成",inputs:["図面・数量","施工条件","単価・見積回答","歩掛・諸経費条件"],outputs:["数量計算書","原価内訳","見積書下書き"],tools:["Estimating calculator","Procurement comparison","Task Registry"],audit:["数量根拠","単価出典・取得日","税区分","見積承認者"]},
 {id:"hr-labor",name:"人事・労務",legacyAgentIds:["hr"],mission:"勤怠、資格、教育、採用、労務期限の管理を支援",inputs:["従業員台帳","勤怠集計","資格・教育期限"],outputs:["期限アラート","労務集計案","採用・教育文案"],tools:["Company Sheets read-only adapter","Task Registry"],audit:["閲覧権限","対象期間","個人情報の最小化","給与・雇用判断の承認"]},
 {id:"legal-contracts",name:"法務・契約",legacyAgentIds:["safety","office"],mission:"契約条件、許認可、法令要件の確認観点と契約文書の下書きを整理",inputs:["契約案","発注条件","公式法令・行政資料"],outputs:["条項チェックリスト","リスク論点","契約修正案"],tools:["Official source research","Task Registry"],audit:["参照法令・版","法的助言ではない旨","専門家確認","締結承認"]},
 {id:"procurement",name:"調達・購買",legacyAgentIds:["procurement"],mission:"材料・外注・重機・車両の相見積比較、在庫・納期・点検期限を整理",inputs:["仕様・数量","見積回答","在庫・納期","取引条件"],outputs:["比較表","発注候補","納期・在庫アラート"],tools:["Procurement comparison","Task Registry"],audit:["比較条件","見積有効期限","利益相反","発注承認"]},
 {id:"safety",name:"安全管理",legacyAgentIds:["safety","construction"],mission:"危険源、KY、法令、安全教育、是正措置の確認を支援",inputs:["作業計画","現場日報","ヒヤリハット","法令・通達"],outputs:["安全チェックリスト","危険予知案","是正タスク"],tools:["Official source research","Task Registry"],audit:["現場・作業","根拠資料","人による現場確認","重大判断の責任者"]},
 {id:"quality",name:"品質管理",legacyAgentIds:["construction"],mission:"施工品質、検査記録、写真、材料証明、是正履歴を整理",inputs:["施工仕様","検査記録","写真メタデータ","材料証明"],outputs:["検査チェックリスト","品質記録案","不適合・是正一覧"],tools:["Task Registry","Quality evidence store when configured"],audit:["検査基準・版","証跡参照","検査者","承認履歴"]},
 {id:"marketing",name:"マーケティング",legacyAgentIds:["content","affiliate"],mission:"市場・競合・顧客ニーズの分析と広告・販促の下書きを作成",inputs:["市場情報","アクセス・反応集計","商品・サービス情報"],outputs:["市場分析","キャンペーン案","広告文下書き"],tools:["Web research","Analytics","Task Registry"],audit:["情報取得日","出典","広告表現チェック","出稿承認"]},
 {id:"video",name:"動画制作",legacyAgentIds:["content"],mission:"企画、史実確認、台本、読み、音声、素材、編集、字幕、品質検査を統括",inputs:["企画テーマ","一次資料","台本・音声・編集資産"],outputs:["検証済み台本","制作チェックリスト","投稿用ドラフト"],tools:["Video Workflow","Descript","Task Registry"],audit:["史料根拠","読み・音声確認","素材権利","公開承認"]},
 {id:"sns",name:"SNS運営",legacyAgentIds:["content","affiliate"],mission:"媒体別投稿案、投稿カレンダー、反応分析、改善案を作成",inputs:["承認済み素材","媒体仕様","Metricool分析"],outputs:["投稿文・タグ案","投稿カレンダー","分析レポート"],tools:["Metricool read-only","Task Registry"],audit:["投稿先・内容","承認記録","公開実行者","分析期間"]},
 {id:"data-analysis",name:"データ分析",legacyAgentIds:["management","tax","trader"],mission:"業務データの品質確認、集計、傾向分析、予測と異常検知",inputs:["許可された業務データ","指標定義","分析条件"],outputs:["再現可能な集計","可視化仕様","異常・予測レポート"],tools:["Data Analytics","PostgreSQL read-only","Task Registry"],audit:["データ範囲","クエリ・計算版","欠損・偏り","再現条件"]},
 {id:"system-development",name:"システム開発",legacyAgentIds:["jarvis"],mission:"要件、設計、実装、テスト、CI、変更管理を安全なブランチで進行",inputs:["要件","GitHub issue・PR","テスト失敗ログ"],outputs:["設計・実装差分","テスト結果","リリース候補"],tools:["GitHub","Task Registry","CI"],audit:["ブランチ所有者","変更ファイル","コミットSHA","CI証跡","本番変更承認"]},
 {id:"audit-security",name:"監査・セキュリティ",legacyAgentIds:["jarvis","safety"],mission:"権限、秘密情報、変更履歴、障害、バックアップ、復旧可能性を独立監査",inputs:["監査ログ","権限設定","構成情報","テスト・障害記録"],outputs:["リスク台帳","監査所見","是正タスク","復旧手順"],tools:["GitHub audit evidence","Render read-only","Task Registry"],audit:["監査対象・期間","証拠参照","重大度","是正担当","再監査結果"]}
].map(item=>Object.freeze({...item,legacyAgentIds:Object.freeze([...item.legacyAgentIds]),inputs:Object.freeze([...item.inputs]),outputs:Object.freeze([...item.outputs]),tools:Object.freeze([...item.tools]),audit:Object.freeze([...item.audit]),permissions:BASE_PERMISSIONS})));

const BY_ID=new Map(DEPARTMENTS.map(item=>[item.id,item]));
function getFunctionalDepartment(id){return BY_ID.get(id)||null;}
function listFunctionalDepartments(){return DEPARTMENTS;}
module.exports={DEPARTMENTS,BASE_PERMISSIONS,getFunctionalDepartment,listFunctionalDepartments};
