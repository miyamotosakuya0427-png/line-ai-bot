# JARVIS durable job journal

This module provides an append-only, fsync-backed job journal for the JARVIS core.
It supports job creation, idempotency keys, status transitions, recovery after restart,
and bounded listing.

## Storage requirement

The journal must live on a persistent filesystem path. Set `JARVIS_JOB_STORE_PATH`
to an absolute path on a persistent mounted disk (for example, under a Render disk
mount). Do not point it at the application directory or an ephemeral filesystem in
production. If no persistent disk is configured, do not enable job writes.

The module is not yet connected to public HTTP routes or a worker. It is deliberately
isolated until the persistent disk is provisioned and tested. It does not modify the
existing LINE server, Apps Script, Google Sheets schema, or production daily reports.

## State model

`queued -> running -> succeeded | failed | cancelled`
A failed job may be retried by moving it back to `queued`. Running jobs may also be
returned to `queued` after a controlled worker restart. Every change is appended and
fsync'd before it becomes visible in memory.

Payloads are JSON objects up to 16 KB. Idempotency keys are optional and prevent
duplicate job creation. Journal corruption fails closed.
