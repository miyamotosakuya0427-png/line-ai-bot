"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxPdfPages: 250,
  maxWorkbookSheets: 100,
  maxCells: 200000,
  maxDocxEntries: 5000,
  maxTextChars: 2_000_000
});
const ALLOWED_EXTENSIONS = new Set([".pdf", ".xlsx", ".xlsm", ".docx"]);
const VERIFICATION = new Set(["VERIFIED", "UNVERIFIED", "UNKNOWN", "EXPIRED", "MISMATCH"]);
const COMPANY_PROFILE_FIELDS = Object.freeze([
  "legalName","corporateNumber","registeredAddress","capital","employeeCount",
  "businessDescription","officeLocations","equipmentInstallationLocation",
  "fiscalYears","corporateTaxFilingStatus","consumptionTaxFilingStatus",
  "taxCertificates","employmentInsuranceStatus","laborInsurancePaymentStatus",
  "equipmentAndVehicles","quotations","businessPlan"
]);
const MATCH_STATES = new Set(["MATCH", "MISMATCH", "UNKNOWN", "EXPIRED"]);

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
function safeString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function assertBuffer(input, limits = DEFAULT_LIMITS) {
  if (!Buffer.isBuffer(input)) throw new TypeError("Document input must be a Buffer");
  if (input.length === 0) throw new Error("EMPTY_FILE");
  if (input.length > limits.maxFileBytes) throw new Error("FILE_TOO_LARGE");
}
function detectFileType(fileName) {
  const ext = path.extname(safeString(fileName, 255)).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error("UNSUPPORTED_FILE_TYPE");
  return ({".pdf":"pdf", ".xlsx":"xlsx", ".xlsm":"xlsm", ".docx":"docx"})[ext];
}
function makeDocumentRecord({fileId, fileName, buffer, source, storageReference, extractionVersion, extractionConfidence, documentStatus = "RECEIVED"}) {
  if (!fileId || typeof fileId !== "string") throw new Error("FILE_ID_REQUIRED");
  assertBuffer(buffer);
  return Object.freeze({
    fileId,
    fileType: detectFileType(fileName),
    originalFileName: safeString(fileName, 255),
    sha256: sha256(buffer),
    fileSize: buffer.length,
    source: safeString(source, 200) || "UNSPECIFIED",
    createdAt: new Date().toISOString(),
    modifiedAt: null,
    extractionVersion: safeString(extractionVersion, 80) || "grant-document-engine/1",
    extractionConfidence: Number.isFinite(extractionConfidence) ? Math.max(0, Math.min(1, extractionConfidence)) : null,
    storageReference: safeString(storageReference, 500) || null,
    documentStatus: safeString(documentStatus, 40)
  });
}
function evidence(value, sourceDocumentId, sourceHash, location, confidence = null) {
  return {
    value: value ?? null,
    sourceDocumentId: sourceDocumentId || null,
    sourceHash: sourceHash || null,
    location: location || null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  };
}
function createCompanyProfile(fields = {}) {
  const profile = {};
  for (const [key, field] of Object.entries(fields)) {
    const item = field && typeof field === "object" && Object.prototype.hasOwnProperty.call(field, "value") ? field : {value: field};
    const status = VERIFICATION.has(item.verificationStatus) ? item.verificationStatus : "UNKNOWN";
    profile[key] = Object.freeze({
      value: item.value ?? null,
      sourceDocumentId: item.sourceDocumentId || null,
      sourceHash: item.sourceHash || null,
      verifiedAt: item.verifiedAt || null,
      validUntil: item.validUntil || null,
      verificationStatus: status,
      verifiedBy: item.verifiedBy || null,
      confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null,
      notes: safeString(item.notes, 1000)
    });
  }
  return Object.freeze(profile);
}
function validDate(value) {
  if (!value) return false;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed);
}
function compareField(masterField, expectedValue, now = new Date()) {
  if (!masterField || masterField.verificationStatus === "UNKNOWN" || masterField.value === null || masterField.value === undefined) return {status:"UNKNOWN", actual:masterField?.value ?? null, expected:expectedValue ?? null};
  if (masterField.validUntil && !validDate(masterField.validUntil)) return {status:"UNKNOWN", actual:masterField.value, expected:expectedValue ?? null};
  if (masterField.validUntil && new Date(masterField.validUntil).getTime() < now.getTime()) return {status:"EXPIRED", actual:masterField.value, expected:expectedValue ?? null};
  if (masterField.verificationStatus !== "VERIFIED") return {status:"UNKNOWN", actual:masterField.value, expected:expectedValue ?? null};
  if (expectedValue === undefined || expectedValue === null || expectedValue === "") return {status:"UNKNOWN", actual:masterField.value, expected:expectedValue ?? null};
  const normalize = v => String(v).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  return {status:normalize(masterField.value) === normalize(expectedValue) ? "MATCH" : "MISMATCH", actual:masterField.value, expected:expectedValue};
}
function compareApplicationFields(profile, expectedFields, now = new Date()) {
  const results = Object.entries(expectedFields || {}).map(([field, expected]) => ({field, ...compareField(profile[field], expected, now)}));
  return {results, canDraft: results.every(r => r.status !== "MISMATCH"), hasUnknown: results.some(r => r.status === "UNKNOWN" || r.status === "EXPIRED")};
}
function evaluateChecklist(requirements, documents, now = new Date()) {
  const results = (requirements || []).map(req => {
    const candidates = (documents || []).filter(doc => doc.documentType === req.documentType);
    if (!candidates.length) return {documentType:req.documentType, required:req.required === true, status:req.required === true ? "MISSING" : "OPTIONAL_MISSING"};
    const valid = candidates.find(doc => {
      if (req.targetFiscalYear && doc.fiscalYear !== req.targetFiscalYear) return false;
      if (req.maxAgeDays && (!validDate(doc.issuedAt) || now.getTime() - new Date(doc.issuedAt).getTime() > req.maxAgeDays * 86400000)) return false;
      if (doc.validUntil && (!validDate(doc.validUntil) || new Date(doc.validUntil).getTime() < now.getTime())) return false;
      return true;
    });
    return {documentType:req.documentType, required:req.required === true, status:valid ? "PRESENT" : "EXPIRED_OR_MISMATCH", documentId:valid?.fileId || candidates[0].fileId};
  });
  return {results, missingRequired:results.filter(r => r.required && r.status !== "PRESENT").map(r => r.documentType), complete:results.every(r => !r.required || r.status === "PRESENT")};
}
function parsePdfCoordinates(transform) {
  return Array.isArray(transform) && transform.length >= 6 ? {x:transform[4], y:transform[5]} : null;
}
async function readPdf(buffer, options = {}) {
  const limits = {...DEFAULT_LIMITS, ...(options.limits || {})};
  assertBuffer(buffer, limits);
  const pdfjs = options.pdfjs || await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({data:new Uint8Array(buffer), useSystemFonts:true, isEvalSupported:false});
  const pdf = await task.promise;
  if (pdf.numPages > limits.maxPdfPages) { await pdf.destroy(); throw new Error("TOO_MANY_PDF_PAGES"); }
  const pages = [];
  let totalChars = 0;
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const textContent = await page.getTextContent();
      const items = (textContent.items || []).filter(item => typeof item.str === "string" && item.str.length).map(item => ({
        text:item.str,
        location:{page:pageNo, ...parsePdfCoordinates(item.transform)},
        confidence:0.98
      }));
      const text = items.map(item => item.text).join(" ");
      totalChars += text.length;
      if (totalChars > limits.maxTextChars) throw new Error("EXTRACTED_TEXT_TOO_LARGE");
      let ocr = null;
      if (!text.trim() && typeof options.ocrAdapter === "function") {
        ocr = await options.ocrAdapter({buffer, pageNo, mimeType:"application/pdf"});
      }
      pages.push({pageNo, text:ocr?.text ? safeString(ocr.text, limits.maxTextChars) : text, items, ocrStatus:ocr?.text ? "OCR_COMPLETED" : text.trim() ? "TEXT_LAYER" : "OCR_REQUIRED", ocrConfidence:Number.isFinite(ocr?.confidence) ? ocr.confidence : null});
      page.cleanup?.();
    }
  } finally {
    await pdf.destroy();
  }
  return {fileType:"pdf", pageCount:pages.length, pages, text:pages.map(p=>p.text).join("\n"), requiresOcr:pages.some(p=>p.ocrStatus==="OCR_REQUIRED"), extractionVersion:"pdfjs-dist/4.10.38"};
}
async function loadSafeZip(buffer, options = {}) {
  const limits={...DEFAULT_LIMITS,...(options.limits||{})};
  const JSZip=options.JSZip || require("jszip");
  const zip=await JSZip.loadAsync(buffer,{checkCRC32:true,createFolders:false});
  const entries=Object.entries(zip.files);
  if(entries.length>limits.maxDocxEntries) throw new Error("TOO_MANY_ARCHIVE_ENTRIES");
  let expanded=0;
  for(const [name,entry] of entries) {
    if(name.startsWith("/") || name.split("/").includes("..")) throw new Error("UNSAFE_ARCHIVE_PATH");
    if(entry.dir) continue;
    const size=Number(entry._data?.uncompressedSize || 0);
    const compressed=Number(entry._data?.compressedSize || 0);
    expanded+=size;
    if(expanded>limits.maxExpandedZipBytes) throw new Error("ARCHIVE_EXPANSION_LIMIT");
    if(compressed>0 && size/compressed>limits.maxZipExpansionRatio) throw new Error("ARCHIVE_EXPANSION_RATIO_LIMIT");
  }
  return zip;
}
async function readExcel(buffer, options = {}) {
  const limits = {...DEFAULT_LIMITS, ...(options.limits || {})};
  assertBuffer(buffer, limits);
  await loadSafeZip(buffer, options);
  const ExcelJS = options.ExcelJS || require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length > limits.maxWorkbookSheets) throw new Error("TOO_MANY_SHEETS");
  const sheets = [];
  let totalCells = 0;
  for (const sheet of workbook.worksheets) {
    const rows = [];
    sheet.eachRow({includeEmpty:true}, row => {
      const cells = [];
      row.eachCell({includeEmpty:true}, cell => {
        totalCells++;
        if (totalCells > limits.maxCells) throw new Error("TOO_MANY_CELLS");
        const formula = cell.formula || cell.sharedFormula || null;
        cells.push({
          address:cell.address,
          value:cell.value instanceof Date ? cell.value.toISOString() : cell.value,
          formula,
          result:cell.value && typeof cell.value === "object" && "result" in cell.value ? cell.value.result : null,
          numFmt:cell.numFmt || null,
          type:cell.type,
          isMerged:cell.isMerged === true
        });
      });
      rows.push({rowNumber:row.number, cells});
    });
    sheets.push({
      name:sheet.name,
      state:sheet.state,
      hidden:sheet.state !== "visible",
      rowCount:sheet.rowCount,
      columnCount:sheet.columnCount,
      merges:[...(sheet.model.merges || [])],
      pageSetup:sheet.pageSetup,
      rows
    });
  }
  return {fileType:"xlsx", sheetCount:sheets.length, sheets, includesHiddenSheets:sheets.some(s=>s.hidden), extractionVersion:"exceljs/4.4.0"};
}
function decodeXml(value) {
  return value.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&");
}
function xmlText(xml) {
  return decodeXml(xml.replace(/<w:tab\b[^>]*\/>/g,"\t").replace(/<w:br\b[^>]*\/>/g,"\n").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim());
}
function extractDocxParagraphs(xml, sourcePart) {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((match, index) => ({
    text:xmlText(match[1]),
    location:{part:sourcePart, paragraph:index + 1},
    style:(match[1].match(/<w:pStyle[^>]*w:val="([^"]+)"/) || [])[1] || null
  })).filter(p=>p.text);
}
function extractDocxTables(xml, sourcePart) {
  const tables=[];
  for (const tableMatch of xml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/g)) {
    const rows=[];
    for (const rowMatch of tableMatch[1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
      const cells=[];
      for (const cellMatch of rowMatch[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) cells.push(xmlText(cellMatch[1]));
      rows.push(cells);
    }
    tables.push({location:{part:sourcePart, table:tables.length+1}, rows});
  }
  return tables;
}
async function readWord(buffer, options = {}) {
  const limits={...DEFAULT_LIMITS,...(options.limits||{})};
  assertBuffer(buffer,limits);
  const JSZip=options.JSZip || require("jszip");
  const zip=await JSZip.loadAsync(buffer,{checkCRC32:true,createFolders:false});
  const names=Object.keys(zip.files);
  if (names.length>limits.maxDocxEntries) throw new Error("TOO_MANY_DOCX_ENTRIES");
  const parts=names.filter(name=>/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)).sort();
  const paragraphs=[], tables=[];
  for (const name of parts) {
    const xml=await zip.file(name).async("string");
    paragraphs.push(...extractDocxParagraphs(xml,name));
    tables.push(...extractDocxTables(xml,name));
  }
  const text=paragraphs.map(p=>p.text).join("\n");
  if (text.length>limits.maxTextChars) throw new Error("EXTRACTED_TEXT_TOO_LARGE");
  return {fileType:"docx", parts, paragraphs, tables, text, extractionVersion:"docx-xml/jszip/3.10.2"};
}
async function readDocument({fileId, fileName, buffer, source, storageReference, ocrAdapter, limits}) {
  const fileType=detectFileType(fileName);
  assertBuffer(buffer,{...DEFAULT_LIMITS,...(limits||{})});
  const parsed=fileType==="pdf" ? await readPdf(buffer,{ocrAdapter,limits}) :
    (fileType==="xlsx" || fileType==="xlsm") ? await readExcel(buffer,{limits}) : await readWord(buffer,{limits});
  const record=makeDocumentRecord({fileId,fileName,buffer,source,storageReference,extractionVersion:parsed.extractionVersion,extractionConfidence:parsed.requiresOcr?null:0.98,documentStatus:parsed.requiresOcr?"OCR_REQUIRED":"EXTRACTED"});
  return {record, parsed};
}
function extractStructuredValues(parsed) {
  const fragments=[];
  const add=(text,location,confidence=0.8)=>{if(typeof text==="string"&&text.trim())fragments.push({text:text.trim(),location,confidence});};
  for(const page of parsed?.pages||[]) for(const item of page.items||[]) add(item.text,item.location,item.confidence);
  for(const sheet of parsed?.sheets||[]) for(const row of sheet.rows||[]) for(const cell of row.cells||[]) {
    const value=cell.value;
    if(value!==null&&value!==undefined&&value!=="") add(String(value),{sheet:sheet.name,cell:cell.address},0.95);
    if(cell.result!==null&&cell.result!==undefined) add(String(cell.result),{sheet:sheet.name,cell:cell.address,kind:"formula-result"},0.9);
  }
  for(const paragraph of parsed?.paragraphs||[]) add(paragraph.text,paragraph.location,0.9);
  for(const table of parsed?.tables||[]) for(let rowIndex=0;rowIndex<(table.rows||[]).length;rowIndex++) {
    for(let cellIndex=0;cellIndex<(table.rows[rowIndex]||[]).length;cellIndex++) {
      add(String(table.rows[rowIndex][cellIndex] ?? ""),{...table.location,row:rowIndex+1,cell:cellIndex+1},0.9);
    }
  }
  const dates=[], amounts=[];
  const datePattern=/(?:令和|平成|昭和)\s*[元0-9０-９]{1,4}年\s*[0-9０-９]{1,2}月\s*[0-9０-９]{1,2}日|20[0-9０-９]{2}[年\/-][0-9０-９]{1,2}[月\/-][0-9０-９]{1,2}日?/g;
  const amountPattern=/(?:¥|￥)?\s*[0-9０-９][0-9０-９,，]*(?:\.[0-9０-９]+)?\s*(?:円|万円|千円)/g;
  for(const fragment of fragments) {
    for(const match of fragment.text.matchAll(datePattern)) dates.push({value:match[0],location:fragment.location,confidence:fragment.confidence});
    for(const match of fragment.text.matchAll(amountPattern)) amounts.push({value:match[0],location:fragment.location,confidence:fragment.confidence});
  }
  return {dates,amounts,sourceFragments:fragments.length};
}
function auditExtraction({originalHash, currentBuffer, requiredFields = [], extractedFields = {}, profile = {}}) {
  const currentHash=sha256(currentBuffer);
  const hashMatches=Boolean(originalHash && currentHash===originalHash);
  const fieldResults=requiredFields.map(field=>{
    const extracted=extractedFields[field];
    const master=profile[field];
    if (!extracted || extracted.value===undefined || extracted.value===null || extracted.value==="") return {field,status:"UNKNOWN"};
    const comparison=compareField(master,extracted.value);
    return {field,status:comparison.status,source:extracted.source || null};
  });
  return {hashMatches,fieldResults,passed:hashMatches && fieldResults.every(r=>r.status==="MATCH"),readyForApproval:false,reason:"Human approval and independent application review are not provided by this document reader."};
}
function buildFieldMapping(templateFields, profile) {
  return (templateFields||[]).map(field=>{
    const master=profile[field.sourceField];
    const verified=master && master.verificationStatus==="VERIFIED" && (!master.validUntil || new Date(master.validUntil).getTime()>=Date.now());
    return {targetField:field.targetField,sourceField:field.sourceField,value:verified?master.value:null,status:verified?"CANDIDATE_VERIFIED":"REVIEW_REQUIRED",sourceDocumentId:master?.sourceDocumentId||null,sourceHash:master?.sourceHash||null,verifiedAt:master?.verifiedAt||null};
  });
}
module.exports={
  DEFAULT_LIMITS, COMPANY_PROFILE_FIELDS, sha256, detectFileType, makeDocumentRecord, evidence,
  createCompanyProfile, compareField, compareApplicationFields, evaluateChecklist,
  readPdf, readExcel, readWord, readDocument, loadSafeZip, extractStructuredValues, auditExtraction, buildFieldMapping
};
