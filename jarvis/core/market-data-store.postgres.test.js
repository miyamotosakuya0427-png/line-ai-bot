"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MarketDataStore } = require("./market-data-store");
const { verifyChain } = require("./market-data-audit");

const databaseUrl = process.env.MARKET_DATA_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);

function fixtureBar(sourceId, openTimeUtc, close = "101") {
  const closeTimeUtc = new Date(Date.parse(openTimeUtc) + 59999).toISOString();
  const value = {
    sourceId,
    provider: "Stage6 PostgreSQL integration fixture",
    licenseId: "synthetic-ci-license",
    venue: "BINANCE_PUBLIC",
    symbol: "BTCJPY",
    currency: "JPY",
    interval: "1m",
    openTimeUtc,
    closeTimeUtc,
    sourceTimestampRaw: openTimeUtc,
    sourceTimezone: "UTC",
    sourceRecordId: "fixture:" + openTimeUtc,
    rawPayload: { openTimeUtc, close },
    receivedAtUtc: "2026-11-22T12:00:00.000Z",
    open: "100",
    high: "103",
    low: "99",
    close,
    volume: "10",
    quoteVolume: null,
    adjustmentState: "raw"
  };
  value.normalizedHash = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  value.rawPayloadHash = crypto.createHash("sha256").update("raw:" + JSON.stringify(value)).digest("hex");
  return value;
}

test("Stage6 PostgreSQL migrations, rollback, idempotency, revisions, audit and concurrent Workers", {
  skip: !enabled
}, async () => {
  const parsed = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Stage6 PostgreSQL integration tests are restricted to isolated localhost PostgreSQL");
  }

  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const migrationsDir = path.join(__dirname, "..", "migrations");
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jarvis_audit_readonly') THEN CREATE ROLE jarvis_audit_readonly NOLOGIN; END IF; END $$;");
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY)");
    await pool.query("REVOKE TEMP ON DATABASE " + '"' + parsed.pathname.slice(1).replace(/"/g, '""') + '"' + " FROM PUBLIC");

    for (const file of ["002_market_data_quality.sql", "003_market_data_license_and_currency.sql", "004_market_data_raw_provenance.sql"]) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await pool.query(sql);
      await pool.query(sql);
    }

    const versions = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(versions.rows.map(row => row.version), ["002", "003", "004"]);

    const grants = await pool.query(
      "SELECT has_table_privilege('jarvis_audit_readonly','market_bars','SELECT') AS can_select, " +
      "has_table_privilege('jarvis_audit_readonly','market_bars','INSERT') AS can_insert, " +
      "has_database_privilege('jarvis_audit_readonly',current_database(),'TEMP') AS can_temp"
    );
    assert.deepEqual(grants.rows[0], { can_select: true, can_insert: false, can_temp: false });

    const sourceId = "10000000-0000-4000-8000-000000000001";
    await pool.query(
      "INSERT INTO market_data_sources(id,source_key,provider,license_id,venue_allowlist,currency_allowlist,enabled,license_approved,license_evidence_ref,license_reviewed_at) " +
      "VALUES($1,'stage6-ci-fixture','Stage6 PostgreSQL integration fixture','synthetic-ci-license',ARRAY['BINANCE_PUBLIC'],ARRAY['JPY'],TRUE,TRUE,'synthetic-ci-evidence',now())",
      [sourceId]
    );
    await assert.rejects(
      () => pool.query(
        "INSERT INTO market_data_sources(source_key,provider,license_id,venue_allowlist,currency_allowlist,enabled) " +
        "VALUES('invalid-enabled-source','fixture','missing-evidence',ARRAY['BINANCE_PUBLIC'],ARRAY['JPY'],TRUE)"
      ),
      /market_data_sources_license_evidence_required/
    );

    const store = new MarketDataStore({ pool });
    const baseTime = Date.parse("2026-11-22T11:00:00.000Z");
    const twoWorkerBar = fixtureBar(sourceId, new Date(baseTime).toISOString());
    const twoWorkerCalls = Array.from({ length: 2 }, () => store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-two-worker-same-payload",
      bars: [twoWorkerBar],
      findings: []
    }));
    const twoWorkerResults = await Promise.all(twoWorkerCalls);
    const storedProvenance = await pool.query("SELECT source_record_id,raw_payload->>'close' AS raw_close FROM market_bars WHERE open_time_utc=$1",[twoWorkerBar.openTimeUtc]);
    assert.equal(storedProvenance.rows[0].source_record_id,"fixture:" + twoWorkerBar.openTimeUtc);
    assert.equal(storedProvenance.rows[0].raw_close,"101");
    assert.equal(twoWorkerResults.filter(result => result.idempotentReplay !== true).length, 1);
    assert.equal(twoWorkerResults.filter(result => result.idempotentReplay === true).length, 1);

    const fiveWorkerBar = fixtureBar(sourceId, new Date(baseTime + 60000).toISOString());
    const fiveWorkerCalls = Array.from({ length: 5 }, () => store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-five-worker-same-payload",
      bars: [fiveWorkerBar],
      findings: []
    }));
    const fiveWorkerResults = await Promise.all(fiveWorkerCalls);
    assert.equal(fiveWorkerResults.filter(result => result.idempotentReplay !== true).length, 1);
    assert.equal(fiveWorkerResults.filter(result => result.idempotentReplay === true).length, 4);

    await assert.rejects(() => store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-two-worker-same-payload",
      bars: [fixtureBar(sourceId, new Date(baseTime).toISOString(), "102")],
      findings: []
    }), /different source or payload/);

    const revisionTime = new Date(baseTime + 120000).toISOString();
    await store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-revision-original",
      bars: [fixtureBar(sourceId, revisionTime, "101")],
      findings: []
    });
    const revisionResult = await store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-revision-correction",
      bars: [fixtureBar(sourceId, revisionTime, "102")],
      findings: []
    });
    assert.equal(revisionResult.quality, "quarantined");
    const revisions = await pool.query("SELECT count(*)::int AS count FROM market_bar_revisions");
    assert.equal(revisions.rows[0].count, 1);

    const correctionTime = new Date(baseTime + 240000).toISOString();
    const blockedBar = fixtureBar(sourceId, correctionTime);
    await store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-finding-blocker",
      bars: [blockedBar],
      findings: [{ code: "MANUAL_REVIEW", severity: "high", details: { fixture: true } }]
    });
    const blocker = await pool.query("SELECT id FROM market_quality_findings WHERE code='MANUAL_REVIEW' AND resolved_at IS NULL ORDER BY detected_at DESC LIMIT 1");
    assert.equal(blocker.rowCount, 1);
    const corrected = await store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-finding-correction",
      bars: [blockedBar],
      findings: [],
      findingCorrections: [{ id: blocker.rows[0].id, resolution: "Synthetic CI evidence reviewed" }]
    });
    assert.equal(corrected.quality, "completed");
    const correctedBar = await pool.query("SELECT verification_status FROM market_bars WHERE open_time_utc=$1", [correctionTime]);
    assert.equal(correctedBar.rows[0].verification_status, "passed");
    const resolvedFinding = await pool.query("SELECT resolved_at,details->>'resolution' AS resolution FROM market_quality_findings WHERE id=$1", [blocker.rows[0].id]);
    assert.ok(resolvedFinding.rows[0].resolved_at);
    assert.equal(resolvedFinding.rows[0].resolution, "Synthetic CI evidence reviewed");

    const beforeRollback = await pool.query("SELECT (SELECT count(*) FROM market_bars)::int AS bars, (SELECT count(*) FROM market_ingest_batches)::int AS batches");
    await assert.rejects(() => store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-forced-rollback",
      bars: [fixtureBar(sourceId, new Date(baseTime + 180000).toISOString())],
      findings: [{ code: "INVALID_SEVERITY_FIXTURE", severity: "fatal", details: {} }]
    }));
    const afterRollback = await pool.query("SELECT (SELECT count(*) FROM market_bars)::int AS bars, (SELECT count(*) FROM market_ingest_batches)::int AS batches");
    assert.deepEqual(afterRollback.rows[0], beforeRollback.rows[0]);
    const retryAfterRollback = await store.ingest({
      sourceId,
      batchId: crypto.randomUUID(),
      idempotencyKey: "stage6-forced-rollback",
      bars: [fixtureBar(sourceId, new Date(baseTime + 180000).toISOString())],
      findings: []
    });
    assert.equal(retryAfterRollback.quality, "completed");

    const audit = await pool.query("SELECT payload, previous_hash AS \"previousHash\", event_hash AS \"eventHash\" FROM market_data_audit_events ORDER BY id");
    assert.equal(verifyChain(audit.rows.map(row => ({ payload: row.payload, previousHash: row.previousHash, eventHash: row.eventHash }))).valid, true);
    assert.ok(audit.rowCount >= 4);
    await assert.rejects(
      () => pool.query("UPDATE market_data_audit_events SET payload='{}'::jsonb WHERE id=$1", [1]),
      /append-only/
    );
    await assert.rejects(
      () => pool.query("DELETE FROM market_data_audit_events WHERE id=$1", [1]),
      /append-only/
    );
  } finally {
    await pool.end();
  }
});
