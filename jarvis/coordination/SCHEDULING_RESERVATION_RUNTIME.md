# Scheduling Reservation Runtime

This runtime is an opt-in composition layer. It is not enabled by the default server startup.

## Composition

Call `createSchedulingReservationRuntime({ pool, calendar, booking, taskRegistry, authorizeApproval, clock })` from `core/scheduling-reservation-runtime.js`.

- `pool`: PostgreSQL pool already configured by the host application.
- `calendar`: read-only calendar adapter exposing `listEvents({ start, end })`.
- `booking`: availability and booking adapter. Confirmation requires `supportsIdempotency === true`, `createReservation()`, and a verified provider idempotency contract.
- `taskRegistry`: the shared Task Registry instance.
- `authorizeApproval`: server-side verifier that validates approver identity, approval expiry/consumption, action type, and the immutable proposal hash.

The runtime `init()` only checks that `jarvis.events` and the recorded `0006_scheduling_reservation_store` migration exist. It never applies a migration.

## HTTP surface

Inject the runtime into `createServer({ schedulingRuntime })`. Routes require the owner bearer token (`JARVIS_OWNER_TOKEN`) and JSON:

- `POST /v1/reservations/propose` — checks calendar conflicts and provider availability, persists a proposal, and creates a Task Registry task.
- `POST /v1/reservations/confirm` — requires both a reservation ID and an approval object; the agent performs the authoritative approval and provider-idempotency checks.
- `POST /v1/reservations/reconcile` — checks an ambiguous provider outcome without blindly retrying.

The default `require.main` server startup does not construct or inject calendar/booking adapters. Until a vetted provider adapter and approval verifier are supplied by the host, these routes fail closed with 503. This is intentional.

## Safety and verification boundary

- No provider is selected or called by this module.
- No production database is connected by this module.
- No migration is run by this module.
- No reservation is confirmed without the agent's immutable-digest approval verification and the provider's idempotency contract.
- HTTP route tests use a fake runtime; they prove authentication and dispatch only, not external service connectivity.
- PostgreSQL store behavior remains covered by the isolated PostgreSQL 16 integration test in `postgres-scheduling-store.integration.test.js`.
