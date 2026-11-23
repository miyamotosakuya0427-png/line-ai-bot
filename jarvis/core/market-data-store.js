"use strict";
const crypto = require("node:crypto");
const { hashEvent } = require("./market-data-audit");
const { stable } = require("./market-data-normalizer");
const { auditBars, qualityGate } = require("./market-data-quality");

function quoteCurrency(bar, allowlist) {
  if (typeof bar.currency === "string" && bar.currency) return bar.currency.toUpperCase();
  const currencies = Array.isArray(allowlist) ? [...allowlist].sort((a,b)=>b.length-a.length) : [];
  return currencies.find(c => String(bar.symbol || "").toUpperCase().endsWith(c)) || null;
}

class MarketDataStore {
  constructor({ pool }) {
    if (!pool || typeof pool.connect !== "function") throw new Error("A PostgreSQL-compatible pool is required");
    this.pool = pool;
  }

  async ingest({ sourceId, batchId, idempotencyKey, bars, findings = [], findingCorrections = [] }) {
    if (!sourceId || !batchId || !idempotencyKey || !Array.isArray(bars) || !Array.isArray(findings) || !Array.isArray(findingCorrections)) {
      throw new Error("Invalid ingest request");
    }
    if (!bars.length) throw new Error("At least one normalized bar is required");
    const payloadHash = crypto.createHash("sha256").update(stable({
      sourceId,
      bars: bars.map(b => ({ normalizedHash: b.normalizedHash, rawPayloadHash: b.rawPayloadHash || null })),
      findings,
      findingCorrections
    })).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Global key lock matches the globally unique database constraint.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["market-ingest-idempotency:" + idempotencyKey]);

      const sourceResult = await client.query(
        "SELECT id, source_key, provider, license_id, license_approved, license_evidence_ref, license_reviewed_at, venue_allowlist, currency_allowlist, enabled FROM market_data_sources WHERE id=$1 FOR SHARE",
        [sourceId]
      );
      if (!sourceResult.rowCount) throw new Error("Market data source is not registered");
      const source = sourceResult.rows[0];
      if (source.enabled !== true) throw new Error("Market data source is disabled");
      if (!source.provider || !source.license_id || source.license_approved !== true || !source.license_evidence_ref || !source.license_reviewed_at) throw new Error("Approved provider and license evidence are required");

      for (const bar of bars) {
        if (!bar || bar.sourceId !== sourceId || bar.provider !== source.provider || bar.licenseId !== source.license_id) {
          throw new Error("Normalized bar source identity does not match registered source");
        }
        if (!Array.isArray(source.venue_allowlist) || !source.venue_allowlist.includes(bar.venue)) {
          throw new Error("Bar venue is not allowlisted by registered source");
        }
        const currency = quoteCurrency(bar, source.currency_allowlist);
        if (!currency || !Array.isArray(source.currency_allowlist) || !source.currency_allowlist.includes(currency)) {
          throw new Error("Bar currency is not allowlisted by registered source");
        }
      }

      const prior = await client.query(
        "SELECT id, source_id, status, raw_payload_hash FROM market_ingest_batches WHERE idempotency_key=$1 FOR UPDATE",
        [idempotencyKey]
      );
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (row.source_id !== sourceId || row.raw_payload_hash !== payloadHash) {
          throw new Error("Idempotency key was already used with a different source or payload");
        }
        if (["completed", "quarantined"].includes(row.status)) {
          await client.query("COMMIT");
          return { idempotentReplay: true, batchId: row.id, inserted: 0, quality: row.status };
        }
        if (row.status !== "failed") throw new Error("Idempotency key is already being processed");
        await client.query(
          "UPDATE market_ingest_batches SET status='running', started_at=now(), completed_at=NULL, error_summary=NULL WHERE id=$1",
          [row.id]
        );
        batchId = row.id;
      } else {
        await client.query(
          "INSERT INTO market_ingest_batches(id,source_id,idempotency_key,symbol,interval,status,input_count,raw_payload_hash) VALUES($1,$2,$3,$4,$5,'running',$6,$7)",
          [batchId, sourceId, idempotencyKey, bars[0].symbol, bars[0].interval, bars.length, payloadHash]
        );
      }

      let inserted = 0;
      let revised = 0;
      const barIds = [];
      const allFindings = [...findings, ...auditBars(bars)];
      for (const bar of bars) {
        const result = await client.query(
          "INSERT INTO market_bars(source_id,venue,symbol,interval,open_time_utc,close_time_utc,source_timestamp_raw,source_timezone,received_at_utc,open,high,low,close,volume,quote_volume,adjustment_state,normalized_hash,raw_payload_hash,quote_currency,verification_status,batch_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'unverified',$20) ON CONFLICT(source_id,venue,symbol,interval,open_time_utc,adjustment_state) DO NOTHING RETURNING id",
          [sourceId,bar.venue,bar.symbol,bar.interval,bar.openTimeUtc,bar.closeTimeUtc,bar.sourceTimestampRaw,bar.sourceTimezone,bar.receivedAtUtc,bar.open,bar.high,bar.low,bar.close,bar.volume,bar.quoteVolume,bar.adjustmentState,bar.normalizedHash,bar.rawPayloadHash||null,quoteCurrency(bar, source.currency_allowlist),batchId]
        );
        if (result.rowCount) { inserted++; barIds.push(result.rows[0].id); continue; }

        const old = await client.query(
          "SELECT id, normalized_hash, to_jsonb(market_bars) AS prior_payload FROM market_bars WHERE source_id=$1 AND venue=$2 AND symbol=$3 AND interval=$4 AND open_time_utc=$5 AND adjustment_state=$6 FOR UPDATE",
          [sourceId,bar.venue,bar.symbol,bar.interval,bar.openTimeUtc,bar.adjustmentState]
        );
        if (!old.rowCount) throw new Error("Conflicting bar disappeared during ingest");
        barIds.push(old.rows[0].id);
        if (old.rows[0].normalized_hash !== bar.normalizedHash) {
          const revision = await client.query(
            "SELECT COALESCE(MAX(revision_no),0)+1 AS next_revision FROM market_bar_revisions WHERE bar_id=$1",
            [old.rows[0].id]
          );
          const revisionNo = Number(revision.rows[0].next_revision);
          await client.query(
            "INSERT INTO market_bar_revisions(bar_id,revision_no,prior_hash,revised_hash,prior_payload,revised_payload,reason,source_batch_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'Provider returned changed candle',$7)",
            [old.rows[0].id,revisionNo,old.rows[0].normalized_hash,bar.normalizedHash,JSON.stringify(old.rows[0].prior_payload),JSON.stringify(bar),batchId]
          );
          await client.query(
            "UPDATE market_bars SET close_time_utc=$2,source_timestamp_raw=$3,source_timezone=$4,received_at_utc=$5,open=$6,high=$7,low=$8,close=$9,volume=$10,quote_volume=$11,normalized_hash=$12,raw_payload_hash=$13,quote_currency=$14,revision_no=$15,verification_status='unverified',batch_id=$16 WHERE id=$1",
            [old.rows[0].id,bar.closeTimeUtc,bar.sourceTimestampRaw,bar.sourceTimezone,bar.receivedAtUtc,bar.open,bar.high,bar.low,bar.close,bar.volume,bar.quoteVolume,bar.normalizedHash,bar.rawPayloadHash||null,quoteCurrency(bar, source.currency_allowlist),revisionNo,batchId]
          );
          allFindings.push({ code:"CANDLE_REVISION", severity:"high", details:{ priorHash:old.rows[0].normalized_hash, newHash:bar.normalizedHash }, barId:old.rows[0].id });
          revised++;
        } else {
          await client.query(
            "UPDATE market_bars SET batch_id=$2, verification_status='unverified' WHERE id=$1",
            [old.rows[0].id,batchId]
          );
        }
      }

      // Finding corrections, unresolved-finding lookup and quality re-evaluation
      // are part of this same transaction as bars, revisions and the audit event.
      const correctionAudit = [];
      for (const correction of findingCorrections) {
        if (!correction || !correction.id || typeof correction.resolution !== "string" || !correction.resolution.trim()) {
          throw new Error("Finding correction requires an id and non-empty resolution");
        }
        const resolved = await client.query(
          "UPDATE market_quality_findings SET resolved_at=now(), details=details || jsonb_build_object('resolution',$2::text,'resolvedAt',now()) WHERE id=$1 AND bar_id=ANY($3::uuid[]) AND resolved_at IS NULL RETURNING id,code,severity",
          [correction.id,correction.resolution.trim(),barIds]
        );
        if (!resolved.rowCount) throw new Error("Finding correction target is missing, already resolved, or outside this batch");
        correctionAudit.push({ id: resolved.rows[0].id, code: resolved.rows[0].code, resolution: correction.resolution.trim() });
      }
      const unresolvedResult = await client.query(
        "SELECT id,code,severity,details,bar_id FROM market_quality_findings WHERE bar_id=ANY($1::uuid[]) AND resolved_at IS NULL FOR UPDATE",
        [barIds]
      );
      const gateFindings = [
        ...unresolvedResult.rows.map(row => ({ code:row.code, severity:row.severity, details:row.details, barId:row.bar_id })),
        ...allFindings
      ];
      const gate = qualityGate(gateFindings);
      for (const finding of allFindings) {
        const findingBarId = finding.barId || (barIds.length === 1 ? barIds[0] : null);
        await client.query(
          "INSERT INTO market_quality_findings(batch_id,bar_id,code,severity,details) VALUES($1,$2,$3,$4,$5::jsonb)",
          [batchId,findingBarId,finding.code,finding.severity,JSON.stringify(finding.details||{})]
        );
      }
      const finalStatus = gate.accepted ? "completed" : "quarantined";
      await client.query(
        "UPDATE market_bars SET verification_status=$2 WHERE id=ANY($1::uuid[])",
        [barIds, gate.accepted ? "passed" : "quarantined"]
      );

      // One transaction-scoped global lock serializes chain-head read + append.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["market_data_audit_events:global"]);
      const chain = await client.query("SELECT event_hash FROM market_data_audit_events ORDER BY id DESC LIMIT 1");
      const previousHash = chain.rows[0]?.event_hash || null;
      const auditPayload = { batchId, sourceId, idempotencyKey, payloadHash, inputCount:bars.length, inserted, revised, findings:allFindings.length, activeFindings:gateFindings.length, findingCorrections:correctionAudit, qualityAccepted:gate.accepted };
      const eventHash = hashEvent(auditPayload, previousHash);
      await client.query(
        "INSERT INTO market_data_audit_events(event_type,resource_type,resource_id,payload,previous_hash,event_hash) VALUES('INGEST','market_ingest_batch',$1,$2::jsonb,$3,$4)",
        [batchId,JSON.stringify(auditPayload),previousHash,eventHash]
      );
      await client.query(
        "UPDATE market_ingest_batches SET status=$2,completed_at=now(),accepted_count=$3,rejected_count=$4 WHERE id=$1",
        [batchId,finalStatus,gate.accepted?inserted:0,gate.accepted?0:gateFindings.length]
      );
      await client.query("COMMIT");
      return { idempotentReplay:false, batchId, inserted, revised, findings:allFindings.length, quality:finalStatus };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
}
module.exports = { MarketDataStore, quoteCurrency };
