"use strict";

const APPROVAL = Object.freeze({
  automatic: "情報収集・分類・集計・下書き・期限監視・内部タスク作成",
  review: "見積・申請書・税務資料・対外文書の提出前レビュー",
  owner: "申請提出・契約・発注・送金・納税・採用確定・公開投稿・データ削除"
});

const DEPARTMENTS = Object.freeze([
  {id:"jarvis",name:"JARVIS統括室",agent:"ONE JARVIS",mission:"全部署の指揮、優先順位付け、重複確認、成果検証、承認待ち管理",canAutonomously:["部署への調査・分析依頼","結果の統合","内部タスク作成"],requiresOwnerApproval:["部署横断の外部実行","権限変更"]},
  {id:"management",name:"経営企画部",agent:"ONE MANAGER",mission:"経営数値、資金繰り、KPI、経営判断の選択肢を整理",canAutonomously:["経営レポート作成","異常値検知","改善案作成"],requiresOwnerApproval:["資金移動","経営契約","投資実行"]},
  {id:"tax",name:"税務・会計部",agent:"ONE TAX",mission:"売上・経費・請求・入金・証憑の照合、月次締め、税務資料の下書き",canAutonomously:["読み取り・集計","不一致検出","会計資料の下書き"],requiresOwnerApproval:["会計データの確定変更","納税・申告提出","税務署等への送信"]},
  {id:"office",name:"事務・補助金助成金部",agent:"ONE OFFICE",mission:"公的支援制度の常時調査、適合度評価、締切管理、申請書類の下書き",canAutonomously:["公式情報の調査","要件と締切の抽出","申請チェックリスト作成","社内通知"],requiresOwnerApproval:["申請提出","誓約・同意","外部機関への送信"]},
  {id:"construction",name:"建設・現場部",agent:"ONE CONSTRUCTION",mission:"現場工程、原価、見積、資材、重機、安全書類の支援",canAutonomously:["工程・原価分析","見積下書き","現場報告整理"],requiresOwnerApproval:["発注・契約","施工条件の確定","安全上の重要判断"]},
  {id:"hr",name:"人事・労務部",agent:"ONE HR",mission:"勤怠、資格、教育、採用、雇用助成金候補の整理",canAutonomously:["期限通知","資格・教育台帳の整理","採用文案作成"],requiresOwnerApproval:["採用・解雇","労働条件変更","給与確定・支払"]},
  {id:"procurement",name:"購買・車両重機部",agent:"ONE PROCUREMENT",mission:"材料・機械・車両の価格比較、在庫・点検・リース期限管理",canAutonomously:["相見積比較","点検期限通知","発注候補作成"],requiresOwnerApproval:["発注","リース・購入契約","支払"]},
  {id:"recycling",name:"資源循環・産廃部",agent:"ONE RECYCLE",mission:"産廃受入・処理・再生材販売、許認可・マニフェスト期限の管理",canAutonomously:["数量・収支分析","許認可期限の通知","市場調査"],requiresOwnerApproval:["処理契約","法定報告提出","廃棄物の受入条件確定"]},
  {id:"safety",name:"安全・法令部",agent:"ONE SAFETY",mission:"建設・電気・産廃関連の法令改正、安全・許認可期限の監視",canAutonomously:["官公庁情報の監視","チェックリスト作成","期限通知"],requiresOwnerApproval:["法的見解の確定","行政への届出・回答"]},
  {id:"content",name:"動画・広報部",agent:"ONE CONTENT",mission:"企画、台本、動画制作、品質確認、投稿案作成",canAutonomously:["企画・台本・編集案作成","誤字・読み確認","投稿予約案作成"],requiresOwnerApproval:["公開投稿","広告出稿","有料素材購入"]},
  {id:"affiliate",name:"販売・アフィリエイト部",agent:"ONE AFFILIATE",mission:"商品調査、記事・導線・成果分析",canAutonomously:["市場調査","記事下書き","成果分析"],requiresOwnerApproval:["広告出稿","契約・購入","公開"]},
  {id:"invest",name:"投資分析部",agent:"ONE INVEST",mission:"投資情報、企業分析、リスク・資産配分の比較",canAutonomously:["情報収集","分析・シミュレーション"],requiresOwnerApproval:["投資注文","資金移動"]},
  {id:"trader",name:"トレード研究部",agent:"ONE TRADER",mission:"相場監視、バックテスト、ペーパートレード、リスク監視",canAutonomously:["相場分析","バックテスト","ペーパートレード"],requiresOwnerApproval:["実資金での注文","レバレッジ変更"]}
].map(item=>Object.freeze({...item,canAutonomously:Object.freeze(item.canAutonomously),requiresOwnerApproval:Object.freeze(item.requiresOwnerApproval)})));

const BY_ID = new Map(DEPARTMENTS.map(item=>[item.id,item]));
function getDepartment(id){return BY_ID.get(id)||null;}
function validateAgentTask({departmentId,actionClass}={}) {
  const department=getDepartment(departmentId);
  if(!department) return {allowed:false,reason:"UNKNOWN_DEPARTMENT"};
  if(actionClass==="read"||actionClass==="analyze"||actionClass==="draft"||actionClass==="notify"||actionClass==="internal_task") return {allowed:true,approvalRequired:false};
  if(actionClass==="external_submit"||actionClass==="financial"||actionClass==="contract"||actionClass==="publish"||actionClass==="delete"||actionClass==="permission_change") return {allowed:false,approvalRequired:true,reason:"OWNER_APPROVAL_REQUIRED"};
  return {allowed:false,approvalRequired:true,reason:"UNKNOWN_ACTION_REQUIRES_REVIEW"};
}
module.exports={DEPARTMENTS,APPROVAL,getDepartment,validateAgentTask};
