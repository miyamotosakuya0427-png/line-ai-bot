#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGPORT:=5432}"
SOURCE_DB="${STAGE12_SOURCE_DB:-jarvis_stage12_source}"
RESTORE_DB="${STAGE12_RESTORE_DB:-jarvis_stage12_restore}"
ARTIFACT_DIR="${STAGE12_ARTIFACT_DIR:-stage12-artifacts}"
mkdir -p "$ARTIFACT_DIR"

echo "PostgreSQL client/server versions:"
psql -X -v ON_ERROR_STOP=1 -d postgres -Atc "SHOW server_version;"
pg_dump --version
pg_restore --version

createdb --maintenance-db=postgres "$SOURCE_DB"
createdb --maintenance-db=postgres "$RESTORE_DB"

for migration in jarvis/migrations/*.sql; do
  echo "Applying isolated migration: $(basename "$migration")"
  psql -X -v ON_ERROR_STOP=1 -d "$SOURCE_DB" -f "$migration" >/dev/null
done

psql -X -v ON_ERROR_STOP=1 -d "$SOURCE_DB" <<'SQL'
INSERT INTO jarvis.worker_registry
(worker_id,agent_id,department_id,instance_id,status,heartbeat_at,version,updated_at)
VALUES ('stage12-worker-1','stage12-agent-1','construction','ci-worker','idle',now(),1,now());

INSERT INTO jarvis.worker_scope_grants
(grant_id,worker_id,project_id,conversation_id,granted_by,created_at)
VALUES ('12000000-0000-4000-8000-000000000001','stage12-worker-1','stage12-project','stage12-conversation','stage12-owner',now());

INSERT INTO jarvis.events
(aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key)
VALUES
('task','stage12-task-1',1,'created',
 '{"taskId":"stage12-task-1","projectId":"stage12-project","ownerConversation":"stage12-conversation","ownerAgent":"stage12-agent-1","department":"construction","title":"synthetic backup restore rehearsal","dedupeKey":"stage12-dedupe-1"}',
 'stage12-task-created'),
('task','stage12-task-1',2,'agent_handoff',
 '{"taskId":"stage12-task-1","projectId":"stage12-project","ownerConversation":"stage12-conversation","ownerAgent":"stage12-agent-1","department":"management","toWorkerId":"stage12-worker-1"}',
 'stage12-task-handoff');

INSERT INTO jarvis.task_registry_agent_revocations(agent_id,revoked_at,revoked_by)
VALUES ('stage12-revoked-agent',now(),'stage12-owner');
SQL

# Capture source fingerprints without emitting credential-bearing connection details.
psql -X -v ON_ERROR_STOP=1 -d "$SOURCE_DB" -AtF '|' <<'SQL' > "$ARTIFACT_DIR/source-fingerprint.txt"
SELECT 'migrations',count(*) FROM jarvis.schema_migrations;
SELECT 'events',count(*),coalesce(string_agg(event_id::text||':'||aggregate_id||':'||aggregate_version::text||':'||event_type,',' ORDER BY event_id),'') FROM jarvis.events;
SELECT 'workers',count(*),coalesce(string_agg(worker_id,',' ORDER BY worker_id),'') FROM jarvis.worker_registry;
SELECT 'grants',count(*),coalesce(string_agg(grant_id::text||':'||worker_id||':'||project_id||':'||conversation_id,',' ORDER BY grant_id),'') FROM jarvis.worker_scope_grants;
SELECT 'outbox',count(*),coalesce(string_agg(source_event_id::text||':'||scope_cursor::text||':'||project_id||':'||conversation_id||':'||task_id,',' ORDER BY outbox_id),'') FROM jarvis.task_event_outbox;
SELECT 'cursors',count(*),coalesce(string_agg(project_id||':'||conversation_id||':'||last_cursor::text,',' ORDER BY project_id,conversation_id),'') FROM jarvis.task_event_outbox_cursors;
SELECT 'revocations',count(*),coalesce(string_agg(agent_id||':'||revoked_by,',' ORDER BY agent_id),'') FROM jarvis.task_registry_agent_revocations;
SQL

backup_start=$(date +%s)
pg_dump --format=custom --no-owner --no-acl --file="$ARTIFACT_DIR/jarvis-stage12.dump" --dbname="$SOURCE_DB"
backup_end=$(date +%s)
sha256sum "$ARTIFACT_DIR/jarvis-stage12.dump" | awk '{print $1}' > "$ARTIFACT_DIR/backup.sha256"
stat -c '%s' "$ARTIFACT_DIR/jarvis-stage12.dump" > "$ARTIFACT_DIR/backup.bytes"

restore_start=$(date +%s)
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_DB" "$ARTIFACT_DIR/jarvis-stage12.dump"
restore_end=$(date +%s)

psql -X -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -AtF '|' <<'SQL' > "$ARTIFACT_DIR/restore-fingerprint.txt"
SELECT 'migrations',count(*) FROM jarvis.schema_migrations;
SELECT 'events',count(*),coalesce(string_agg(event_id::text||':'||aggregate_id||':'||aggregate_version::text||':'||event_type,',' ORDER BY event_id),'') FROM jarvis.events;
SELECT 'workers',count(*),coalesce(string_agg(worker_id,',' ORDER BY worker_id),'') FROM jarvis.worker_registry;
SELECT 'grants',count(*),coalesce(string_agg(grant_id::text||':'||worker_id||':'||project_id||':'||conversation_id,',' ORDER BY grant_id),'') FROM jarvis.worker_scope_grants;
SELECT 'outbox',count(*),coalesce(string_agg(source_event_id::text||':'||scope_cursor::text||':'||project_id||':'||conversation_id||':'||task_id,',' ORDER BY outbox_id),'') FROM jarvis.task_event_outbox;
SELECT 'cursors',count(*),coalesce(string_agg(project_id||':'||conversation_id||':'||last_cursor::text,',' ORDER BY project_id,conversation_id),'') FROM jarvis.task_event_outbox_cursors;
SELECT 'revocations',count(*),coalesce(string_agg(agent_id||':'||revoked_by,',' ORDER BY agent_id),'') FROM jarvis.task_registry_agent_revocations;
SQL

diff -u "$ARTIFACT_DIR/source-fingerprint.txt" "$ARTIFACT_DIR/restore-fingerprint.txt"
test "$(cat "$ARTIFACT_DIR/backup.sha256")" = "$(sha256sum "$ARTIFACT_DIR/jarvis-stage12.dump" | awk '{print $1}')"
test "$(psql -X -d "$RESTORE_DB" -Atc "SELECT count(*) FROM jarvis.schema_migrations WHERE version IN ('0001_neon_event_store','0002_job_approval_stores','0003_append_only_event_ledger','0004_task_registry','0005_task_registry_scoped_dedupe','0006_scheduling_reservation_store','0007_execution_kernel_fencing','0008_worker_scope_grants','0009_task_event_outbox','0010_task_registry_agent_revocations')")" = "10"
test "$(psql -X -d "$RESTORE_DB" -Atc "SELECT count(*) FROM jarvis.task_event_outbox o JOIN jarvis.events e ON e.event_id=o.source_event_id WHERE e.aggregate_type='task'")" = "2"
test "$(psql -X -d "$RESTORE_DB" -Atc "SELECT count(*) FROM jarvis.worker_scope_grants g JOIN jarvis.worker_registry w USING(worker_id)")" = "1"
test "$(psql -X -d "$RESTORE_DB" -Atc "SELECT last_cursor FROM jarvis.task_event_outbox_cursors WHERE project_id='stage12-project' AND conversation_id='stage12-conversation'")" = "2"

# Verify append-only protection in the restored database; expected SQL errors are suppressed.
if psql -X -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -c "UPDATE jarvis.events SET event_type='tampered' WHERE aggregate_id='stage12-task-1'" >/dev/null 2>&1; then
  echo "FAIL: event ledger accepted UPDATE" >&2; exit 1
fi
if psql -X -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -c "DELETE FROM jarvis.task_registry_agent_revocations WHERE agent_id='stage12-revoked-agent'" >/dev/null 2>&1; then
  echo "FAIL: revocation ledger accepted DELETE" >&2; exit 1
fi
# Re-run only idempotent 0009/0010 DDL in the isolated restore DB; do not reset data.
psql -X -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -f jarvis/migrations/0009_task_event_outbox.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 -d "$RESTORE_DB" -f jarvis/migrations/0010_task_registry_agent_revocations.sql >/dev/null
test "$(psql -X -d "$RESTORE_DB" -Atc "SELECT count(*) FROM jarvis.task_registry_agent_revocations WHERE agent_id='stage12-revoked-agent'")" = "1"

cat > "$ARTIFACT_DIR/metrics.txt" <<EOF
backup_seconds=$((backup_end-backup_start))
restore_seconds=$((restore_end-restore_start))
backup_bytes=$(cat "$ARTIFACT_DIR/backup.bytes")
backup_sha256=$(cat "$ARTIFACT_DIR/backup.sha256")
source_database=$SOURCE_DB
restore_database=$RESTORE_DB
postgres_server_version=$(psql -X -d "$RESTORE_DB" -Atc "SHOW server_version")
EOF

echo "PASS: PostgreSQL 16 isolated pg_dump/pg_restore and data reconciliation completed."
cat "$ARTIFACT_DIR/metrics.txt"
