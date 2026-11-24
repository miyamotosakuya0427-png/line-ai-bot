"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "migrations");
const migration002 = fs.readFileSync(path.join(root, "002_market_data_quality.sql"), "utf8");
const migration003 = fs.readFileSync(path.join(root, "003_market_data_license_and_currency.sql"), "utf8");

test("market-data base migration uses rerunnable table and index DDL", () => {
  assert.match(migration002, /CREATE TABLE IF NOT EXISTS market_data_sources/);
  assert.match(migration002, /CREATE TABLE IF NOT EXISTS market_bars/);
  assert.match(migration002, /CREATE INDEX IF NOT EXISTS market_bars_lookup_idx/);
  assert.match(migration002, /CREATE OR REPLACE FUNCTION reject_market_audit_mutation/);
  assert.match(migration002, /DROP TRIGGER IF EXISTS market_data_audit_no_update_delete/);
  assert.match(migration002, /CREATE TRIGGER market_data_audit_no_update_delete/);
  assert.ok(migration002.includes("VALUES ('002')"));
});

test("license migration has a valid rerunnable DO block and records version 003", () => {
  assert.match(migration003, /ADD COLUMN IF NOT EXISTS license_approved/);
  assert.match(migration003, /ADD COLUMN IF NOT EXISTS license_evidence_ref/);
  assert.match(migration003, /ADD COLUMN IF NOT EXISTS license_reviewed_at/);
  assert.match(migration003, /enabled = FALSE OR \(license_approved = TRUE/);
  assert.match(migration003, /ADD COLUMN IF NOT EXISTS quote_currency/);
  assert.match(migration003, /market_bars_quote_currency_format/);
  assert.match(migration003, /END \$\$;/);
  assert.doesNotMatch(migration003, /END \$;/);
  assert.ok(migration003.includes("VALUES ('003')"));
});

test("raw source record and payload migration is rerunnable",()=>{
 const migration004=fs.readFileSync(path.join(root,"004_market_data_raw_provenance.sql"),"utf8");
 assert.match(migration004,/ADD COLUMN IF NOT EXISTS source_record_id/);
 assert.match(migration004,/ADD COLUMN IF NOT EXISTS raw_payload JSONB/);
 assert.match(migration004,/CREATE UNIQUE INDEX IF NOT EXISTS market_bars_source_record_id_key/);
 assert.ok(migration004.includes("VALUES ('004')"));
});
