"use strict";
const crypto=require("node:crypto");
const STATUS=new Set(["MATCH","MISMATCH","UNKNOWN","EXPIRED"]);
const sha256=v=>crypto.createHash("sha256").update(v).digest("hex");
const xmlEscape=v=>String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const xmlDecode=v=>v.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");
function safeName(v,max=80){return String(v||"").normalize("NFKC").replaceAll("/","_").replace(/[\\:*?"<>|]/g,"_").replace(/[\x00-\x1f]/g,"_").replace(/\s+/g,"_").slice(0,max)||"document";}
function outputFileName({company="株式会社One",program,document,date=new Date(),version=1,extension}){
 const ymd=date instanceof Date?date.toISOString().slice(0,10).replace(/-/g,""):String(date).replace(/[^0-9]/g,"").slice(0,8);
 const ext=String(extension||"").replace(/^\./,"").toLowerCase(); if(!["pdf","xlsx","xlsm","docx"].includes(ext))throw Error("UNSUPPORTED_OUTPUT_EXTENSION");
 return safeName(company)+"_"+safeName(program)+"_"+safeName(document)+"_"+ymd+"_v"+String(version).padStart(3,"0")+"."+ext;
}
function resolveTransferValue(x,now=new Date()){
 if(!x||!STATUS.has(x.status))return{eligible:false,status:"UNKNOWN",value:null,reason:"INVALID_STATUS"};
 if(x.status==="MISMATCH")return{eligible:false,status:"MISMATCH",value:null,reason:"SOURCE_MISMATCH"};
 if(x.status==="EXPIRED")return{eligible:false,status:"EXPIRED",value:null,reason:"EVIDENCE_EXPIRED"};
 if(x.status!=="MATCH"&&x.status!=="CANDIDATE_VERIFIED")return{eligible:false,status:"UNKNOWN",value:null,reason:"NOT_VERIFIED"};
 if(x.verificationStatus!=="VERIFIED"||x.value===null||x.value===undefined||x.value==="")return{eligible:false,status:"UNKNOWN",value:null,reason:"MISSING_VERIFIED_VALUE"};
 if(!x.sourceDocumentId||!x.sourceHash||!x.verifiedAt)return{eligible:false,status:"UNKNOWN",value:null,reason:"MISSING_PROVENANCE"};
 if(x.validUntil){const t=Date.parse(x.validUntil);if(!Number.isFinite(t))return{eligible:false,status:"UNKNOWN",value:null,reason:"INVALID_EXPIRY"};if(t<now.getTime())return{eligible:false,status:"EXPIRED",value:null,reason:"EVIDENCE_EXPIRED"};}
 return{eligible:true,status:"MATCH",value:x.value,reason:null,evidence:{sourceDocumentId:x.sourceDocumentId,sourceHash:x.sourceHash,verifiedAt:x.verifiedAt,verifiedBy:x.verifiedBy||null}};
}
function summarizeMappings(mappings,now=new Date()){
 const results=(mappings||[]).map(x=>({...x,resolution:resolveTransferValue(x,now)}));
 return{results,missing:results.filter(x=>!x.resolution.eligible&&x.resolution.status!=="MISMATCH"),mismatches:results.filter(x=>x.resolution.status==="MISMATCH"),eligible:results.every(x=>x.resolution.eligible)};
}
async function inspectPdfForm(buffer,options={}){
 const {PDFDocument}=options.pdfLib||require("pdf-lib");const pdf=await PDFDocument.load(buffer,{updateMetadata:false,ignoreEncryption:false});const fields=pdf.getForm().getFields().map(f=>({name:f.getName(),type:f.constructor?.name||"Unknown",readOnly:typeof f.isReadOnly==="function"?f.isReadOnly():false}));
 return{pageCount:pdf.getPageCount(),fields,hasAcroForm:fields.length>0};
}
async function fillPdfForm(buffer,mappings,options={}){
 const {PDFDocument}=options.pdfLib||require("pdf-lib");const fontkit=options.fontkit||require("@pdf-lib/fontkit");const pdf=await PDFDocument.load(buffer,{updateMetadata:false,ignoreEncryption:false});const form=pdf.getForm();const fields=form.getFields();const byName=new Map(fields.map(f=>[f.getName(),f]));const sum=summarizeMappings(mappings,options.now||new Date());
 const report={format:"pdf",templateHash:sha256(buffer),pageCountBefore:pdf.getPageCount(),filled:[],skipped:[],layoutChecks:{pageCountPreserved:null,visualInspectionRequired:true,fontEmbedded:Boolean(options.fontBytes)}};
 if(!fields.length)return{buffer:null,report:{...report,blocked:true,reason:"PDF_HAS_NO_ACROFORM"}};
 if(sum.mismatches.length)return{buffer:null,report:{...report,blocked:true,reason:"MISMATCH_PRESENT"}};
 let font=null;if(options.fontBytes){pdf.registerFontkit(fontkit);font=await pdf.embedFont(options.fontBytes,{subset:true});}
 for(const item of sum.results){
  const name=item.targetField||item.fieldName;const field=byName.get(name);
  if(!field){report.skipped.push({field:name,status:"UNKNOWN",reason:"PDF_FIELD_NOT_FOUND"});continue;}
  if(!item.resolution.eligible){report.skipped.push({field:name,status:item.resolution.status,reason:item.resolution.reason});continue;}
  if(typeof field.isReadOnly==="function"&&field.isReadOnly()){report.skipped.push({field:name,status:"UNKNOWN",reason:"READ_ONLY_FIELD"});continue;}
  if(field.constructor?.name!=="PDFTextField"){report.skipped.push({field:name,status:"UNKNOWN",reason:"UNSUPPORTED_FIELD_TYPE"});continue;}
  try{field.setText(String(item.resolution.value));report.filled.push({field:name,value:String(item.resolution.value),evidence:item.resolution.evidence});}
  catch{report.skipped.push({field:name,status:"UNKNOWN",reason:"FIELD_VALUE_REJECTED"});}
 }
 form.updateFieldAppearances(font||undefined);const out=Buffer.from(await pdf.save({useObjectStreams:false,addDefaultPage:false}));report.pageCountAfter=pdf.getPageCount();report.layoutChecks.pageCountPreserved=report.pageCountAfter===report.pageCountBefore;report.outputHash=sha256(out);
 report.blocked=report.filled.length===0||!report.layoutChecks.pageCountPreserved||report.skipped.length>0;report.reason=report.blocked?"REVIEW_REQUIRED":"GENERATED_VISUAL_REVIEW_REQUIRED";return{buffer:report.blocked?null:out,report};
}
async function fillExcelTemplate(buffer,mappings,options={}){
 const ExcelJS=options.ExcelJS||require("exceljs");const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
 const before=wb.worksheets.map(s=>({name:s.name,state:s.state,merges:[...(s.model.merges||[])],pageSetup:JSON.stringify(s.pageSetup||{}),views:JSON.stringify(s.views||[])}));const sum=summarizeMappings(mappings,options.now||new Date());
 const report={format:"xlsx",templateHash:sha256(buffer),filled:[],skipped:[],mismatches:sum.mismatches.map(x=>x.targetField||x.cellAddress)};
 if(sum.mismatches.length)return{buffer:null,report:{...report,blocked:true,reason:"MISMATCH_PRESENT"}};
 for(const item of sum.results){
  const target=item.targetField||item.cellAddress;const sheet=wb.getWorksheet(item.sheetName);
  if(!sheet||!item.cellAddress){report.skipped.push({field:target,status:"UNKNOWN",reason:"TARGET_CELL_NOT_FOUND"});continue;}
  const cell=sheet.getCell(item.cellAddress);if(!item.resolution.eligible){report.skipped.push({field:target,status:item.resolution.status,reason:item.resolution.reason});continue;}
  if(cell.formula||(cell.value&&typeof cell.value==="object"&&("formula" in cell.value||"sharedFormula" in cell.value))){report.skipped.push({field:target,status:"UNKNOWN",reason:"FORMULA_CELL_PROTECTED"});continue;}
  if(cell.isMerged&&cell.master.address!==cell.address){report.skipped.push({field:target,status:"UNKNOWN",reason:"MERGED_NON_MASTER_CELL"});continue;}
  cell.value=item.resolution.value;report.filled.push({sheet:item.sheetName,cell:item.cellAddress,value:item.resolution.value,evidence:item.resolution.evidence});
 }
 const after=wb.worksheets.map(s=>({name:s.name,state:s.state,merges:[...(s.model.merges||[])],pageSetup:JSON.stringify(s.pageSetup||{}),views:JSON.stringify(s.views||[])}));report.structuralPreservation=JSON.stringify(before)===JSON.stringify(after);
 const out=Buffer.from(await wb.xlsx.writeBuffer());report.outputHash=sha256(out);report.blocked=report.filled.length===0||report.skipped.length>0||!report.structuralPreservation;report.reason=report.blocked?"REVIEW_REQUIRED":"GENERATED_REQUIRES_RENDERED_VISUAL_REVIEW";return{buffer:report.blocked?null:out,report};
}
function replaceIsolatedPlaceholder(paragraph,placeholder,value){
 const nodes=[...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];if(!nodes.length)return{paragraph,changed:false,reason:"PLACEHOLDER_NOT_FOUND"};
 const joined=nodes.map(n=>xmlDecode(n[1])).join("");const token="{{"+placeholder+"}}";if(!joined.includes(token))return{paragraph,changed:false,reason:"PLACEHOLDER_NOT_FOUND"};if(joined.trim()!==token)return{paragraph,changed:false,reason:"WORD_PLACEHOLDER_NOT_ISOLATED"};
 let i=0;const rewritten=paragraph.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g,(_w,attrs)=>{const t=i++===0?xmlEscape(value):"";const preserve=t.startsWith(" ")||t.endsWith(" ")?' xml:space="preserve"':"";return"<w:t"+(attrs||"")+preserve+">"+t+"</w:t>";});return{paragraph:rewritten,changed:true};
}
async function fillWordTemplate(buffer,mappings,options={}){
 const JSZip=options.JSZip||require("jszip");const zip=await JSZip.loadAsync(buffer,{checkCRC32:true,createFolders:false});const sum=summarizeMappings(mappings,options.now||new Date());const report={format:"docx",templateHash:sha256(buffer),filled:[],skipped:[],mismatches:sum.mismatches.map(x=>x.placeholder)};
 if(sum.mismatches.length)return{buffer:null,report:{...report,blocked:true,reason:"MISMATCH_PRESENT"}};
 const parts=Object.keys(zip.files).filter(n=>/^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
 for(const item of sum.results){
  const placeholder=item.placeholder||item.targetField;if(!item.resolution.eligible){report.skipped.push({placeholder,status:item.resolution.status,reason:item.resolution.reason});continue;}
  let replaced=false,unsafe=false;
  for(const part of parts){const entry=zip.file(part);if(!entry)continue;let xml=await entry.async("string");xml=xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,p=>{const r=replaceIsolatedPlaceholder(p,placeholder,String(item.resolution.value));if(r.reason==="WORD_PLACEHOLDER_NOT_ISOLATED")unsafe=true;if(r.changed)replaced=true;return r.paragraph;});zip.file(part,xml);}
  if(replaced)report.filled.push({placeholder,value:String(item.resolution.value),evidence:item.resolution.evidence});else report.skipped.push({placeholder,status:"UNKNOWN",reason:unsafe?"WORD_PLACEHOLDER_NOT_ISOLATED":"PLACEHOLDER_NOT_FOUND"});
 }
 const out=Buffer.from(await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}}));report.outputHash=sha256(out);report.blocked=report.filled.length===0||report.skipped.length>0;report.reason=report.blocked?"REVIEW_REQUIRED":"GENERATED_REQUIRES_WORD_RENDER_VISUAL_REVIEW";return{buffer:report.blocked?null:out,report};
}
function auditGeneratedForm({templateBuffer,outputBuffer,report,mappings,applicationId,officialRuleHash,companyProfileHash}){
 const th=sha256(templateBuffer),oh=outputBuffer?sha256(outputBuffer):null,sum=summarizeMappings(mappings);const hashes=Boolean(oh&&report?.templateHash===th&&report?.outputHash===oh);
 const passed=Boolean(hashes&&!report?.blocked&&sum.eligible&&!sum.mismatches.length&&applicationId&&officialRuleHash&&companyProfileHash);
 return{auditType:"INDEPENDENT_REVIEW_REQUIRED",templateHash:th,outputHash:oh,hashMatches:hashes,allMappedEvidenceVerified:sum.eligible,mismatchCount:sum.mismatches.length,missingOrUnknownCount:sum.missing.length,passed,readyForApproval:false,approvalFingerprint:applicationId&&oh&&officialRuleHash&&companyProfileHash?{applicationId,applicationFileHash:oh,officialRuleHash,companyProfileHash}:null,reason:passed?"PASS_PENDING_SEPARATE_HUMAN_AND_INDEPENDENT_AUDIT":"BLOCKED_OR_REVIEW_REQUIRED"};
}
function buildReviewBundle({program,document,format,date,version,templateBuffer,outputBuffer,report,audit,checklist,finalReview=[]}){
 const outputName=outputBuffer?outputFileName({program,document,date,version,extension:format}):null;const manifest={outputFileName:outputName,outputSha256:outputBuffer?sha256(outputBuffer):null,templateSha256:sha256(templateBuffer),filledFields:report?.filled||[],unfilledFields:report?.skipped||[],mismatches:report?.mismatches||[],checklist:checklist||null,audit:audit||null,finalHumanReview:finalReview,status:report?.blocked||!audit?.passed?"BLOCKED":"READY_FOR_SEPARATE_REVIEW",externalSubmissionPerformed:false};
 return{outputName,outputBuffer:manifest.status==="READY_FOR_SEPARATE_REVIEW"?outputBuffer:null,manifest,manifestJson:JSON.stringify(manifest,null,2)};
}
module.exports={sha256,outputFileName,resolveTransferValue,summarizeMappings,inspectPdfForm,fillPdfForm,fillExcelTemplate,fillWordTemplate,auditGeneratedForm,buildReviewBundle};
