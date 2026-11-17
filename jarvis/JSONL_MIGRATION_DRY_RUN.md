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

## Current limitations
This phase does not write PostgreSQL, prove that the live Neon schema matches every historical record, perform rollback, or execute production migration. It checks the job and approval snapshot contracts used by the current stores. Legacy records that predate newer optional approval fields are retained as optional; a later compatibility review must confirm their application semantics before import.
