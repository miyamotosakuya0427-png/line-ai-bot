# ONE JARVIS scheduling and reservation agent

## Scope
The scheduling agent coordinates calendar availability, booking-provider availability, durable reservation proposals, approval-gated booking, and outcome reconciliation. It is a core orchestration contract, not a live booking integration.

## Required adapters
- Calendar: `listEvents({start,end})`; all timestamps must be timezone-qualified ISO 8601.
- Booking: `searchAvailability`, and for booking, `supportsIdempotency === true` plus `createReservation` accepting a stable idempotency key. Outcome reconciliation requires `getReservationByIdempotencyKey`.
- Durable store: `create`, `get`, `update`; production implementations must be PostgreSQL-backed with optimistic concurrency and append-only audit.
- Task Registry: `createTask`.
- Approval verifier: approval must be bound to the exact immutable proposal digest and action.

## Safety rules
- Proposals and availability searches do not create bookings.
- A matching explicit approval is required for a reservation create.
- Payment, cancellation, outbound messages, and irreversible changes require separate action-specific approvals.
- A timeout after request dispatch is `outcome_unknown`; do not retry. Reconcile by provider idempotency key. A provider "not found" response alone is not proof that a delayed request cannot still complete.
- Providers without a verified idempotency contract fail closed.
- Calendar conflicts are checked both at proposal and immediately before booking. This remains a TOCTOU limitation unless the calendar provider supports atomic holds.
- No live calendar, restaurant, hotel, flight, medical, vehicle, or other booking adapter is connected by this PR.
- No external booking, payment, email, SMS, publication, or production write is performed by tests.

## Initial integrations
Connect one calendar provider first (Google Calendar or iCloud Calendar), then add booking adapters one category at a time. Restaurant availability and reservation confirmation must use a provider that supports real-time availability and idempotency; otherwise keep the workflow as human-confirmed external handoff.
