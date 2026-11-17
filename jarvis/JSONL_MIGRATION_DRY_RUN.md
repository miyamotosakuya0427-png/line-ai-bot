# JSONL migration inspection — dry-run only

This utility inspects existing job and approval JSONL journals and produces a deterministic report. It is not a migration writer.

## Safety contract
- Only explicit absolute paths are accepted: \`--jobs\` and \`--approvals\`.
- \`--dry-run\` is the default; the flag is accepted for clarity.
- Files are opened read-only. No truncation, rename, append, or chmod is performed.
- The utility does not import \`pg\`, read \`DATABASE_URL\`, connect to PostgreSQL, or contact Neon.
- It has no write mode. Unsupported flags are rejected.
- A missing source file, malformed event, invalid field, duplicate initial aggregate, or duplicate idempotency key makes the report fail closed.
- Existing JSONL is an append-only snapshot journal: repeated IDs across legitimate state snapshots are expected. The report reduces valid snapshots to the latest record per ID, while flagging repeated initial snapshots and cross-aggregate idempotency collisions.

## Usage
Run from \`jarvis/\`:

\`\`\`sh
npm run migration:dry-run -- --jobs /absolute/path/jobs.jsonl --approvals /absolute/path/approvals.jsonl
\`\`\`

The command emits JSON to stdout and exits with code 2 if any issue is found. It reports raw-file SHA-256 and canonical latest-record SHA-256 separately, event counts, latest aggregate counts, invalid lines, schema issues, duplicate IDs, and duplicate idempotency keys. Canonical object keys are sorted recursively; array order is preserved.

## Interpretation and reconciliation
- \`rawSha256\` protects the exact source bytes, including line endings and whitespace.
- \`canonicalLatestSha256\` protects the latest logical snapshots sorted by aggregate ID.
- \`validEvents\` is the number of schema-valid event lines; \`latestRecords\` is the number of latest aggregate snapshots.
- Job and approval journals are reported separately. Do not compare their checksums to one combined value.
- Any discrepancy or issue must be resolved and the dry-run repeated. Do not discard invalid rows to force a pass.

## Recovery procedure
1. Stop before any migration or dual-write operation.
2. Preserve the original files and take an independently managed backup using the approved operational backup procedure.
3. Record the report and raw checksums securely; do not paste personal or confidential payloads into tickets.
4. Repair malformed or conflicting data only in a separate reviewed copy. Never edit the source JSONL in place.
5. Re-run the dry-run against the reviewed copy and compare event counts, latest counts, and checksums.
6. A later migration phase must use a separately reviewed importer, a disposable PostgreSQL database, transaction boundaries, idempotent upserts, row-by-row reconciliation, and a rollback plan. This utility does none of those things.

## Storage path discovery

The application obtains the job journal path from `JARVIS_JOB_STORE_PATH`. The approval journal path is `JARVIS_APPROVAL_STORE_PATH`, or defaults to `${JARVIS_JOB_STORE_PATH}.approvals`. These are environment-provided absolute paths; source code does not reveal their runtime values. The dedicated Render `one-jarvis` service is currently on branch `one-jarvis-foundation`, while this work is on the PR branch; no live service filesystem path or file bytes are exposed by the repository inspection. Therefore no real-data dry-run was attempted. Do not infer a path or read a different branch's data as a substitute.

## Fixture-only PostgreSQL rehearsal

`npm test` includes `scripts/postgres-migration-rehearsal.test.js` and the real PostgreSQL integration test. The rehearsal accepts synthetic arrays only and refuses pools whose configured connection string is not loopback or whose database name does not contain `test`. It writes one version-1 event per aggregate in a single transaction, preserves the complete JSON payload (including job lease and approval digest fields), compares canonical checksums and counts, and rolls back on any conflict. Identical fixture replays are treated as already imported; conflicting aggregate payloads abort rather than overwrite. The integration test injects a mid-transaction failure, verifies row counts return to their prior value, imports fixtures, replays them, and checks store API reads. No JSONL file or Neon endpoint is passed to this function.

## Recovery and cutover rules

- On any checksum/count mismatch, conflict, or injected/real failure, stop; the rehearsal transaction rolls back. Keep the source JSONL untouched.
- Do not point the rehearsal at Neon or a production connection string. It refuses non-loopback hosts and non-test database names.
- For a future production migration, freeze writers, preserve a verified backup, record source checksums, migrate in a separately approved maintenance window, compare every aggregate and idempotency key, then switch storage only after independent sign-off. Rollback means restore the prior application storage configuration and retain original JSONL; never delete or overwrite it.

## Current limitations
This phase does not write PostgreSQL, prove that the live Neon schema matches every historical record, perform rollback, or execute production migration. It checks the job and approval snapshot contracts used by the current stores. Legacy records that predate newer optional approval fields are retained as optional; a later compatibility review must confirm their application semantics before import.
