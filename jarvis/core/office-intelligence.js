"use strict";
const SOURCES = Object.freeze([
 {id:"okayama-pref-subsidy",department:"事務部",category:"岡山県の補助金",name:"岡山県 補助金・助成制度",url:"https://www.pref.okayama.jp/",authority:"岡山県",priority:"high"},
 {id:"okayama-city-subsidy",department:"事務部",category:"岡山市の補助金",name:"岡山市 事業者向け補助金・助成金",url:"https://www.city.okayama.jp/jigyosha/category/5-7-3-4-0-0-0-0-0-0.html",authority:"岡山市",priority:"high"},
 {id:"kurashiki-industry",department:"事務部",category:"倉敷市の補助金",name:"倉敷市 産業・事業者向け補助金",url:"https://www.city.kurashiki.okayama.jp/business/industry/1012617/index.html",authority:"倉敷市",priority:"high"},
 {id:"kurashiki-energy",department:"事務部",category:"省エネ・再エネ",name:"倉敷市 中小企業者等の省エネルギー設備等導入補助",url:"https://www.city.kurashiki.okayama.jp/kurashi/kankyo/1011736/1003554/1024166/1024175.html",authority:"倉敷市",priority:"high"},
 {id:"mirasapo",department:"事務部",category:"国の中小企業補助金",name:"ミラサポplus 補助金・助成金",url:"https://mirasapo-plus.go.jp/",authority:"中小企業庁",priority:"high"},
 {id:"chusho-kobo",department:"事務部",category:"公募・採択",name:"中小企業庁 補助金公募情報",url:"https://www.chusho.meti.go.jp/koukai/hojyokin/kobo.html",authority:"中小企業庁",priority:"high"},
 {id:"mhlw-subsidy",department:"事務部",category:"雇用・人材・建設業助成金",name:"厚生労働省 雇用関係助成金",url:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/kyufukin/index_00057.html",authority:"厚生労働省",priority:"high"},
 {id:"mhlw-construction",department:"事務部",category:"建設業・人材育成",name:"厚生労働省 建設事業主等に対する助成金",url:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyou/kyufukin/index_00057.html",authority:"厚生労働省",priority:"high"},
 {id:"nta-news",department:"税務部",category:"税制改正・税務新着",name:"国税庁 新着情報",url:"https://www.nta.go.jp/",authority:"国税庁",priority:"high"},
 {id:"nta-invoice",department:"税務部",category:"消費税・インボイス",name:"国税庁 インボイス制度・令和8年度改正",url:"https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/invoice-review/index.htm",authority:"国税庁",priority:"high"},
 {id:"nta-records",department:"税務部",category:"帳簿・書類保存",name:"国税庁 法人の帳簿書類等の保存期間",url:"https://www.nta.go.jp/taxes/shiraberu/taxanswer/hojin/5930.htm",authority:"国税庁",priority:"normal"},
 {id:"etax-news",department:"税務部",category:"電子申告・税務手続",name:"e-Tax お知らせ・更新情報",url:"https://www.e-tax.nta.go.jp/topics/",authority:"国税庁",priority:"normal"}
]);
const WATCH_AREAS = Object.freeze([
 "土木・建設・電気工事","蓄電池・太陽光・再生可能エネルギー","省エネ設備","産業廃棄物・木材チップ・リサイクル","重機・車両・設備投資","新事業・販路開拓","IT・AI・DX・業務自動化","採用・賃上げ・人材育成・資格取得","安全衛生・働き方改革","税制改正・法人税・消費税・インボイス・電子帳簿保存"
]);
function getOfficeIntelligence({asOfDate}={}) {
 const date=asOfDate||new Date().toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid as-of date");
 return {asOfDate:date,departments:[
  {id:"tax",name:"税務部",responsibilities:["売上・経費・請求・入金・利益の月次確認","税制改正・法人税・消費税・インボイス・電子帳簿保存の公式情報確認","申告期限・納付期限・帳簿保存の確認"],sources:SOURCES.filter(s=>s.department==="税務部")},
  {id:"administration",name:"事務部",responsibilities:["国・岡山県・岡山市・倉敷市等の補助金・助成金の募集情報確認","募集開始・締切・予算終了・要件変更の追跡","申請条件・必要書類・公式窓口の整理"],sources:SOURCES.filter(s=>s.department==="事務部")}
 ],watchAreas:WATCH_AREAS,monitoring:{mode:"official-source-first",requiresOfficialPageVerification:true,notifyOn:["new-program","application-open","deadline-change","budget-exhausted","guideline-change","application-reopened"],noChangeReport:true,applicationSubmission:false}};
}
module.exports={SOURCES,WATCH_AREAS,getOfficeIntelligence};
