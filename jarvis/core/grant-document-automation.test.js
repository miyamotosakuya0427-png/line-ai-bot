"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const engine=require("./grant-document-automation");

test("SHA-256 and document manifest are stable and do not expose file content",()=>{
  const data=Buffer.from("synthetic fixture");
  const record=engine.makeDocumentRecord({fileId:"fixture-1",fileName:"sample.pdf",buffer:data,source:"test"});
  assert.equal(record.sha256,engine.sha256(data));
  assert.equal(record.fileSize,data.length);
  assert.equal(record.documentStatus,"RECEIVED");
  assert.equal(JSON.stringify(record).includes("synthetic fixture"),false);
});
test("rejects unsupported, empty, and oversized files",()=>{
  assert.throws(()=>engine.detectFileType("invoice.exe"),/UNSUPPORTED_FILE_TYPE/);
  assert.throws(()=>engine.makeDocumentRecord({fileId:"x",fileName:"x.pdf",buffer:Buffer.alloc(0)}),/EMPTY_FILE/);
  assert.throws(()=>engine.readPdf(Buffer.alloc(9),{limits:{maxFileBytes:8},pdfjs:{}}),/FILE_TOO_LARGE/);
});
test("company master retains provenance and unknowns never become matches",()=>{
  const profile=engine.createCompanyProfile({
    legalName:{value:"株式会社One",verificationStatus:"VERIFIED",sourceDocumentId:"doc-1",sourceHash:"abc",verifiedAt:"2026-11-01T00:00:00Z",confidence:0.99},
    capital:{value:null,verificationStatus:"UNKNOWN"}
  });
  assert.equal(engine.compareField(profile.legalName,"株式会社One").status,"MATCH");
  assert.equal(engine.compareField(profile.legalName,"株式会社Other").status,"MISMATCH");
  assert.equal(engine.compareField(profile.capital,10000000).status,"UNKNOWN");
  assert.equal(profile.legalName.sourceDocumentId,"doc-1");
});
test("expired evidence is distinct from unknown and mismatch",()=>{
  const field={value:"岡山市",verificationStatus:"VERIFIED",validUntil:"2020-01-01T00:00:00Z"};
  assert.equal(engine.compareField(field,"岡山市",new Date("2026-01-01")).status,"EXPIRED");
});
test("checklist detects required missing, stale fiscal year, and optional documents",()=>{
  const result=engine.evaluateChecklist([
    {documentType:"決算書",required:true,targetFiscalYear:"2025"},
    {documentType:"納税証明",required:true},
    {documentType:"会社案内",required:false}
  ],[{fileId:"f1",documentType:"決算書",fiscalYear:"2024"}],new Date("2026-11-26"));
  assert.deepEqual(result.missingRequired,["決算書","納税証明"]);
  assert.equal(result.complete,false);
});
test("PDF reader records page numbers and OCR requirement without inventing text",async()=>{
  let destroyed=false;
  const pdfjs={getDocument:()=>({promise:Promise.resolve({
    numPages:2,
    getPage:async n=>({getTextContent:async()=>({items:n===1?[{str:"金額 1000円",transform:[1,0,0,1,25,40]}]:[]}),cleanup(){}}),
    destroy:async()=>{destroyed=true;}
  })})};
  const parsed=await engine.readPdf(Buffer.from("pdf-fixture"),{pdfjs});
  assert.equal(parsed.pageCount,2);
  assert.equal(parsed.pages[0].items[0].location.page,1);
  assert.deepEqual(parsed.pages[0].items[0].location,{page:1,x:25,y:40});
  assert.equal(parsed.pages[1].ocrStatus,"OCR_REQUIRED");
  assert.equal(parsed.requiresOcr,true);
  assert.equal(destroyed,true);
});
test("PDF OCR adapter is opt-in and page-scoped",async()=>{
  const pdfjs={getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[]}),cleanup(){}}),destroy:async()=>{}})})};
  const parsed=await engine.readPdf(Buffer.from("pdf-fixture"),{pdfjs,ocrAdapter:async({pageNo})=>({text:"OCR金額",confidence:0.82,pageNo})});
  assert.equal(parsed.pages[0].text,"OCR金額");
  assert.equal(parsed.pages[0].ocrStatus,"OCR_COMPLETED");
  assert.equal(parsed.pages[0].ocrConfidence,0.82);
});
test("Excel reader retains hidden sheets, formulas, merged cells and print settings",async()=>{
  const cell=(address,value,extra={})=>({address,value,formula:extra.formula||null,sharedFormula:null,result:null,numFmt:extra.numFmt||null,type:extra.type||"String",isMerged:extra.isMerged||false});
  const sheet={name:"見積",state:"visible",rowCount:1,columnCount:2,model:{merges:["A1:B1"]},pageSetup:{printArea:"A1:B2"},eachRow:(_opts,cb)=>cb({number:1,eachCell:(_o,fn)=>{fn(cell("A1",{formula:"1+2",result:3},{formula:"1+2"}));fn(cell("B1",new Date("2026-01-01T00:00:00Z"),{numFmt:"yyyy-mm-dd"}));}})};
  const hidden={...sheet,name:"非表示",state:"hidden",model:{merges:[]}};
  class Workbook{constructor(){this.worksheets=[sheet,hidden];this.xlsx={load:async()=>{}};}}
  const parsed=await engine.readExcel(Buffer.from("xlsx-fixture"),{ExcelJS:{Workbook}});
  assert.equal(parsed.sheetCount,2);
  assert.equal(parsed.includesHiddenSheets,true);
  assert.deepEqual(parsed.sheets[0].merges,["A1:B1"]);
  assert.equal(parsed.sheets[0].rows[0].cells[0].formula,"1+2");
  assert.equal(parsed.sheets[0].pageSetup.printArea,"A1:B2");
});
test("Word reader extracts body, tables, headers and footers",async()=>{
  const files={
    "word/document.xml":'<w:document><w:body><w:p><w:r><w:t>会社名</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>金額</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    "word/header1.xml":'<w:hdr><w:p><w:r><w:t>ヘッダー</w:t></w:r></w:p></w:hdr>',
    "word/footer1.xml":'<w:ftr><w:p><w:r><w:t>フッター</w:t></w:r></w:p></w:ftr>'
  };
  const zip={files:Object.fromEntries(Object.keys(files).map(k=>[k,{}])),file:name=>({async:async()=>files[name]})};
  const parsed=await engine.readWord(Buffer.from("docx-fixture"),{JSZip:{loadAsync:async()=>zip}});
  assert.equal(parsed.paragraphs.length,3);
  assert.equal(parsed.tables.length,1);
  assert.deepEqual(parsed.tables[0].rows,[["金額","1200"]]);
  assert.ok(parsed.parts.includes("word/header1.xml"));
  assert.ok(parsed.parts.includes("word/footer1.xml"));
});
test("field mapping leaves unknown or unverified items blank",()=>{
  const profile=engine.createCompanyProfile({
    name:{value:"株式会社One",verificationStatus:"VERIFIED",sourceDocumentId:"doc-2",sourceHash:"hash",verifiedAt:"2026-11-01"},
    employeeCount:{value:10,verificationStatus:"UNKNOWN"}
  });
  const mapped=engine.buildFieldMapping([{targetField:"法人名",sourceField:"name"},{targetField:"従業員数",sourceField:"employeeCount"}],profile);
  assert.equal(mapped[0].value,"株式会社One");
  assert.equal(mapped[0].status,"CANDIDATE_VERIFIED");
  assert.equal(mapped[1].value,null);
  assert.equal(mapped[1].status,"REVIEW_REQUIRED");
});
test("independent audit fails closed on hash mismatch and unknown company fields",()=>{
  const data=Buffer.from("original");
  const audit=engine.auditExtraction({originalHash:engine.sha256(Buffer.from("different")),currentBuffer:data,requiredFields:["legalName"],extractedFields:{legalName:{value:"株式会社One"}},profile:{}});
  assert.equal(audit.hashMatches,false);
  assert.equal(audit.passed,false);
  assert.equal(audit.readyForApproval,false);
});
test("application field comparison never treats unknown as match",()=>{
  const profile=engine.createCompanyProfile({corporateNumber:{value:null,verificationStatus:"UNKNOWN"}});
  const result=engine.compareApplicationFields(profile,{corporateNumber:"1234567890123"});
  assert.equal(result.results[0].status,"UNKNOWN");
  assert.equal(result.canDraft,true);
  assert.equal(result.hasUnknown,true);
});

test("company master exposes required evidence fields as UNKNOWN by default",()=>{
  const profile=engine.createCompanyProfile({});
  for(const field of engine.COMPANY_PROFILE_FIELDS) assert.equal(profile[field].verificationStatus,"UNKNOWN");
});
test("structured date and amount extraction keeps source locations",()=>{
  const values=engine.extractStructuredValues({pages:[{items:[{text:"発行日 2026年11月26日 金額 12,500円",location:{page:3,x:1,y:2},confidence:0.9}]}]});
  assert.equal(values.dates[0].value,"2026年11月26日");
  assert.equal(values.amounts[0].value,"12,500円");
  assert.deepEqual(values.dates[0].location,{page:3,x:1,y:2});
});

test("checklist fails closed when a required issue date or expiry date is invalid",()=>{
  const result=engine.evaluateChecklist([
    {documentType:"納税証明",required:true,maxAgeDays:365}
  ],[{fileId:"bad-date",documentType:"納税証明",issuedAt:"not-a-date"}],new Date("2026-11-26"));
  assert.equal(result.complete,false);
  assert.deepEqual(result.missingRequired,["納税証明"]);
  assert.equal(engine.compareField({value:"法人名",verificationStatus:"VERIFIED",validUntil:"bad-date"},"法人名").status,"UNKNOWN");
});

test("structured extraction includes Word table cell evidence",()=>{
  const values=engine.extractStructuredValues({tables:[{location:{part:"word/document.xml",table:1},rows:[["提出日 2026年11月26日","金額 5,000円"]]}]});
  assert.equal(values.dates[0].value,"2026年11月26日");
  assert.equal(values.amounts[0].value,"5,000円");
  assert.deepEqual(values.amounts[0].location,{part:"word/document.xml",table:1,row:1,cell:2});
});
