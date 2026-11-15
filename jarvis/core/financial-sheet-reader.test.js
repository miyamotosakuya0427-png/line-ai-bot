"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {readFinancialSheets,SALES_HEADERS,EXPENSE_HEADERS,parseDate,parseYen}=require("./financial-sheet-reader");
const sales=[SALES_HEADERS,["S-1","2026/11/01","P1","岡山現場","得意先A","工事","1,000,000","100,000","1,100,000","I-1","",""]];
const expenses=[EXPENSE_HEADERS,["E-1","2026/11/02","P1","岡山現場","工事原価","外注費","業者A","400,000","40,000","440,000","振込","","",""]];
test("reads only exact approved financial headers and aggregates tax-exclusive yen",()=>{
 const result=readFinancialSheets({salesRows:sales,expenseRows:expenses});
 assert.equal(result.revenueYen,1000000);assert.equal(result.expenseYen,400000);assert.equal(result.profitYen,600000);
 assert.equal(result.profitMargin,60);assert.equal(result.byProject[0].name,"岡山現場");
 assert.deepEqual(result.sourceSheets,["売上","経費"]);
});
test("fails closed on unknown headers, invalid amounts, and malformed dates",()=>{
 assert.throws(()=>readFinancialSheets({salesRows:[["売上ID","別の日付"]],expenseRows:expenses}),/見出し/);
 const bad=[SALES_HEADERS,["S-2","2026/02/30","P1","現場","","","100","","","","",""]];
 assert.throws(()=>readFinancialSheets({salesRows:bad,expenseRows:expenses}),/不正データ/);
 const badAmount=[...sales.slice(0,1),["S-2","2026/11/01","P1","現場","","","-100","","","","",""]];
 assert.throws(()=>readFinancialSheets({salesRows:badAmount,expenseRows:expenses}),/不正データ/);
});
test("does not expose customers, payees, invoice ids, receipts or notes",()=>{
 const result=readFinancialSheets({salesRows:sales,expenseRows:expenses});
 const serialized=JSON.stringify(result);
 for(const privateValue of ["得意先A","業者A","I-1","領収書URL"]) assert.equal(serialized.includes(privateValue),false);
});
test("validates Japanese date and yen formats",()=>{
 assert.equal(parseDate("2026/9/3"),"2026-09-03");assert.equal(parseDate("2026-02-30"),null);
 assert.equal(parseYen("￥1,234"),1234);assert.equal(parseYen("-1"),null);assert.equal(parseYen("1.5"),null);
});


test("summarizes invoices, collections, outstanding and overdue balances without customer or bank data",()=>{
 const {readReceivablesSheets,INVOICE_HEADERS,PAYMENT_HEADERS}=require("./financial-sheet-reader");
 const result=readReceivablesSheets({
  asOfDate:"2026-11-16",
  invoiceRows:[INVOICE_HEADERS,
   ["I-1","INV-001","2026/10/01","2026/10/31","P1","岡山現場","顧客秘密","500000","50000","550000","200000","350000","一部入金","備考秘密"],
   ["I-2","INV-002","2026/11/01","2026/11/30","P2","倉敷現場","顧客B","100000","10000","110000","0","110000","未入金",""]
  ],
  paymentRows:[PAYMENT_HEADERS,
   ["P-1","2026/11/05","I-1","P1","岡山現場","顧客秘密","200000","振込","口座秘密",""]
  ]
 });
 assert.equal(result.billedYen,660000);assert.equal(result.receivedYen,200000);assert.equal(result.outstandingYen,460000);
 assert.equal(result.overdueInvoiceCount,1);assert.equal(result.overdueYen,350000);
 assert.equal(result.paymentReconciliationDifferenceYen,0);
 const text=JSON.stringify(result);
 for(const secret of ["顧客秘密","口座秘密","備考秘密","INV-001"])assert.equal(text.includes(secret),false);
});

test("fails closed on duplicate invoice ids and invalid due dates",()=>{
 const {readReceivablesSheets,INVOICE_HEADERS,PAYMENT_HEADERS}=require("./financial-sheet-reader");
 const invoice=["I-1","INV","2026/10/01","2026/02/30","P1","現場","","100","0","100","0","100","",""];
 const payments=PAYMENT_HEADERS;
 assert.throws(()=>readReceivablesSheets({asOfDate:"2026-11-16",invoiceRows:[INVOICE_HEADERS,invoice],paymentRows:[payments]}),/不正データ/);
});
