"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
let JSZip,ExcelJS,PDFDocument;
try { JSZip=require("jszip"); ExcelJS=require("exceljs"); ({PDFDocument}=require("pdf-lib")); } catch {}
const engine=require("./grant-form-generation");
const now=new Date("2026-11-26T00:00:00Z");
const good={status:"MATCH",verificationStatus:"VERIFIED",value:"Example Co Ltd",sourceDocumentId:"fixture-cert-1",sourceHash:"a".repeat(64),verifiedAt:"2026-11-20T00:00:00Z",verifiedBy:"fixture-auditor"};

test("only verified evidence with provenance is transferable",()=>{
 assert.equal(engine.resolveTransferValue({...good}).eligible,true);
 assert.equal(engine.resolveTransferValue({...good,status:"CANDIDATE_VERIFIED"}).eligible,true);
 assert.equal(engine.resolveTransferValue({...good,status:"UNKNOWN"}).value,null);
 assert.equal(engine.resolveTransferValue({...good,status:"MISMATCH"}).status,"MISMATCH");
 assert.equal(engine.resolveTransferValue({...good,status:"EXPIRED"}).status,"EXPIRED");
 assert.equal(engine.resolveTransferValue({...good,sourceHash:null}).status,"UNKNOWN");
 assert.equal(engine.resolveTransferValue({...good,validUntil:"bad-date"}).status,"UNKNOWN");
 assert.equal(engine.resolveTransferValue({...good,validUntil:"2020-01-01"} ,now).status,"EXPIRED");
});
test("output file naming is versioned and sanitizes path characters",()=>{
 const name=engine.outputFileName({program:"grant/2026",document:"application",date:"2026-11-26",version:2,extension:"xlsx"});
 assert.equal(name,"株式会社One_grant_2026_application_20261126_v002.xlsx");
 assert.equal(name.includes("/"),false);
});
test("PDF AcroForm fields are inspected and text field can be filled without changing page count", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const pdf=await PDFDocument.create();const page=pdf.addPage([595,842]);const field=pdf.getForm().createTextField("legalName");field.addToPage(page,{x:50,y:700,width:250,height:24});
 const original=Buffer.from(await pdf.save());
 const info=await engine.inspectPdfForm(original);
 assert.equal(info.pageCount,1);assert.equal(info.fields[0].name,"legalName");assert.equal(info.fields[0].type,"PDFTextField");
 const result=await engine.fillPdfForm(original,[{targetField:"legalName",...good}],{now});
 assert.ok(result.buffer);assert.equal(result.report.blocked,false);assert.equal(result.report.layoutChecks.pageCountPreserved,true);
 const output=await PDFDocument.load(result.buffer);assert.equal(output.getForm().getTextField("legalName").getText(),"Example Co Ltd");
 assert.notEqual(engine.sha256(original),engine.sha256(result.buffer));
});
test("PDF without AcroForm is stopped without generating an output", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const pdf=await PDFDocument.create();pdf.addPage([300,300]);const original=Buffer.from(await pdf.save());
 const result=await engine.fillPdfForm(original,[{targetField:"legalName",...good}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.reason,"PDF_HAS_NO_ACROFORM");
});
test("PDF mismatch blocks all output", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const pdf=await PDFDocument.create();const page=pdf.addPage();pdf.getForm().createTextField("legalName").addToPage(page,{x:20,y:20,width:100,height:20});
 const result=await engine.fillPdfForm(Buffer.from(await pdf.save()),[{targetField:"legalName",...good,status:"MISMATCH"}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.reason,"MISMATCH_PRESENT");
});
test("Excel fill preserves formulas, merged cells, hidden sheets and print area", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const wb=new ExcelJS.Workbook();const s=wb.addWorksheet("Form");s.getCell("A1").value="{{legalName}}";s.getCell("B1").value={formula:"1+2",result:3};s.mergeCells("A2:B2");s.getCell("A2").value="Merged";
 s.pageSetup.printArea="A1:B3";const hidden=wb.addWorksheet("Hidden");hidden.state="hidden";hidden.getCell("A1").value="Keep";
 const original=Buffer.from(await wb.xlsx.writeBuffer());
 const result=await engine.fillExcelTemplate(original,[{targetField:"法人名",sheetName:"Form",cellAddress:"A1",...good}],{now});
 assert.ok(result.buffer);assert.equal(result.report.blocked,false);assert.equal(result.report.structuralPreservation,true);
 const out=new ExcelJS.Workbook();await out.xlsx.load(result.buffer);
 assert.equal(out.getWorksheet("Form").getCell("A1").value,"Example Co Ltd");assert.equal(out.getWorksheet("Form").getCell("B1").formula,"1+2");
 assert.equal(out.getWorksheet("Form").pageSetup.printArea,"A1:B3");assert.equal(out.getWorksheet("Hidden").state,"hidden");
});
test("Excel formula target is protected and produces no deliverable", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const wb=new ExcelJS.Workbook();const s=wb.addWorksheet("Form");s.getCell("A1").value={formula:"1+2",result:3};const original=Buffer.from(await wb.xlsx.writeBuffer());
 const result=await engine.fillExcelTemplate(original,[{targetField:"total",sheetName:"Form",cellAddress:"A1",...good}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.skipped[0].reason,"FORMULA_CELL_PROTECTED");
});
test("Excel unknown fields remain blank and block deliverable", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const wb=new ExcelJS.Workbook();wb.addWorksheet("Form").getCell("A1").value="";const original=Buffer.from(await wb.xlsx.writeBuffer());
 const result=await engine.fillExcelTemplate(original,[{targetField:"unknown",sheetName:"Form",cellAddress:"A1",...good,status:"UNKNOWN"}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.skipped[0].status,"UNKNOWN");
});
test("Word placeholder across split runs is filled while preserving paragraph structure", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const zip=new JSZip();zip.file("word/document.xml",'<w:document><w:body><w:p><w:r><w:t>{{legal</w:t></w:r><w:r><w:t>Name}}</w:t></w:r></w:p></w:body></w:document>');
 zip.file("word/header1.xml",'<w:hdr><w:p><w:r><w:t>{{legalName}}</w:t></w:r></w:p></w:hdr>');
 const original=await zip.generateAsync({type:"nodebuffer"});
 const result=await engine.fillWordTemplate(original,[{placeholder:"legalName",...good}],{now});
 assert.ok(result.buffer);assert.equal(result.report.blocked,false);
 const out=await JSZip.loadAsync(result.buffer);const xml=await out.file("word/document.xml").async("string");const header=await out.file("word/header1.xml").async("string");
 assert.match(xml,/Example Co Ltd/);assert.match(header,/Example Co Ltd/);assert.equal((xml.match(/<w:p/g)||[]).length,1);
});
test("Word mixed-content placeholder is not rewritten", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const zip=new JSZip();zip.file("word/document.xml",'<w:document><w:body><w:p><w:r><w:t>Company: {{legalName}}</w:t></w:r></w:p></w:body></w:document>');
 const original=await zip.generateAsync({type:"nodebuffer"});
 const result=await engine.fillWordTemplate(original,[{placeholder:"legalName",...good}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.skipped[0].reason,"WORD_PLACEHOLDER_NOT_ISOLATED");
});
test("Word mismatch blocks output", {skip:!JSZip||!ExcelJS||!PDFDocument},async()=>{
 const zip=new JSZip();zip.file("word/document.xml",'<w:document><w:body><w:p><w:r><w:t>{{legalName}}</w:t></w:r></w:p></w:body></w:document>');
 const result=await engine.fillWordTemplate(await zip.generateAsync({type:"nodebuffer"}),[{placeholder:"legalName",...good,status:"MISMATCH"}],{now});
 assert.equal(result.buffer,null);assert.equal(result.report.reason,"MISMATCH_PRESENT");
});
test("independent audit fingerprints immutable application evidence and never approves",()=>{
 const template=Buffer.from("template"),output=Buffer.from("output");
 const report={templateHash:engine.sha256(template),outputHash:engine.sha256(output),blocked:false};
 const audit=engine.auditGeneratedForm({templateBuffer:template,outputBuffer:output,report,mappings:[good],applicationId:"app-fixture",officialRuleHash:"rule-hash",companyProfileHash:"profile-hash"});
 assert.equal(audit.passed,true);assert.equal(audit.readyForApproval,false);assert.equal(audit.approvalFingerprint.applicationFileHash,engine.sha256(output));
 const changed=engine.auditGeneratedForm({templateBuffer:template,outputBuffer:Buffer.from("tampered"),report,mappings:[good],applicationId:"app-fixture",officialRuleHash:"rule-hash",companyProfileHash:"profile-hash"});
 assert.equal(changed.passed,false);
});
test("review bundle excludes output unless independent audit passes",()=>{
 const template=Buffer.from("t"),output=Buffer.from("o");
 const blocked=engine.buildReviewBundle({program:"grant",document:"form",format:"pdf",templateBuffer:template,outputBuffer:output,report:{blocked:false},audit:{passed:false}});
 assert.equal(blocked.outputBuffer,null);assert.equal(blocked.manifest.externalSubmissionPerformed,false);
});
