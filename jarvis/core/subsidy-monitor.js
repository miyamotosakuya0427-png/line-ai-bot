"use strict";

const SUBSIDY_SOURCES=Object.freeze([
 {id:"national-mirasapo",name:"ミラサポplus（国の補助金・助成金）",url:"https://mirasapo-plus.go.jp/",scope:"national",topics:["中小企業","設備投資","省力化","DX","販路開拓","新事業"]},
 {id:"chusho-kobo",name:"中小企業庁 補助金公募情報",url:"https://www.chusho.meti.go.jp/koukai/hojyokin/kobo.html",scope:"national",topics:["中小企業","公募","設備投資","事業承継"]},
 {id:"mhlw-subsidy",name:"厚生労働省 雇用関係助成金",url:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/kyufukin/000763045.html",scope:"national",topics:["雇用","人材育成","賃上げ","労務"]},
 {id:"okayama-pref",name:"岡山県 事業者向け支援情報",url:"https://www.pref.okayama.jp/",scope:"okayama-prefecture",topics:["建設","設備投資","省エネ","雇用","産業廃棄物","再資源化"]},
 {id:"okayama-city",name:"岡山市 補助金・助成金",url:"https://www.city.okayama.jp/jigyosha/category/5-7-3-4-0-0-0-0-0-0.html",scope:"okayama-city",topics:["DX","AI","設備投資","事業承継","中小企業"]},
 {id:"kurashiki-city",name:"倉敷市 事業・補助金（産業）",url:"https://www.city.kurashiki.okayama.jp/business/industry/1012617/index.html",scope:"kurashiki-city",topics:["製造","新分野","人材育成","地域資源","設備投資"]},
 {id:"tokushima-pref",name:"徳島県 助成・融資（商工業）",url:"https://www.pref.tokushima.lg.jp/jigyoshanokata/sangyo/shokogyo/zyoseiyushi/",scope:"tokushima-prefecture",topics:["中小企業","GX","生産性向上","雇用","物流"]},
 {id:"tokushima-labor",name:"徳島県 助成・融資（労働関係）",url:"https://www.pref.tokushima.lg.jp/jigyoshanokata/sangyo/rodokankei/zyoseiyushi/",scope:"tokushima-prefecture",topics:["賃上げ","採用","職場環境","人材確保"]},
 {id:"yoshinogawa",name:"吉野川市 事業者向け制度",url:"https://www.city.yoshinogawa.lg.jp/",scope:"yoshinogawa-city",topics:["創業","設備","地域産業"]}
].map(item=>Object.freeze({...item,topics:Object.freeze(item.topics)})));

const PRIORITY_TOPICS=Object.freeze([
 "建設業の設備・ICT・省力化投資","重機・車両・運搬設備","蓄電池・太陽光・電気工事・省エネ・GX",
 "木くず・がれき・再生材・産業廃棄物・資源循環","人材採用・資格取得・技能講習・人材育成",
 "賃上げ・雇用環境・労働安全衛生","事業承継・新規事業・事業拡大","AI・DX・業務自動化"
]);
const REPORT_FIELDS=Object.freeze(["制度名","実施主体","対象地域","対象事業者","対象経費","補助率","上限額","受付開始日","締切日","予算・残枠（公式確認時のみ）","必要書類","申請窓口","公式URL","最終確認日時","変更点","Oneへの適合度","不足している確認事項"]);
function classifyUpdate({previousFingerprint,currentFingerprint,verified=true}={}) {
 if(!verified) return "unverified";
 if(!currentFingerprint) return "unknown";
 if(!previousFingerprint) return "new";
 return previousFingerprint===currentFingerprint?"unchanged":"changed";
}
function isActionable(item) {
 return Boolean(item&&item.officialUrl&&item.verifiedAt&&item.programName&&item.deadlineStatus!=="closed"&&item.eligibilityStatus!=="ineligible");
}
module.exports={SUBSIDY_SOURCES,PRIORITY_TOPICS,REPORT_FIELDS,classifyUpdate,isActionable};
