# ONE JARVIS scheduling and reservation agent

## Scope
The scheduling agent coordinates calendar availability, booking-provider availability, durable reservation proposals, approval-gated booking, and outcome reconciliation. It is an orchestration contract, not proof of a live provider connection.

## Persistence and audit
- `createPostgresSchedulingStore({pool})` is implemented in `jarvis/core/postgres-scheduling-store.js`.
- Migration `0006_scheduling_reservation_store.sql` adds reservation-ledger indexes and records its migration version. It reuses the existing append-only `jarvis.events` ledger; it does not create a mutable reservation table.
- Reservation state snapshots are append-only `aggregate_type='reservation'` events. Audit entries are separate append-only `aggregate_type='reservation_audit'` events, written in the same PostgreSQL transaction as each state change.
- Reservation creation is deduplicated by the provider-independent idempotency key. A conflicting payload with the same key fails closed.
- State transitions use transaction-scoped advisory locks and an explicit transition graph. A concurrent second transition from the same state is rejected.
- The adapter checks that migration 0006 is already installed. It never applies migrations itself. The server/runtime is not yet wired to instantiate this store; do not enable it against production until a separately reviewed migration and runtime rollout.
- CI uses a separate disposable PostgreSQL 16 service/database for this integration test. The test refuses non-loopback hosts and database names without `test`.

## Required adapters
- Calendar: `listEvents({start,end})`; all timestamps must be timezone-qualified ISO 8601.
- Booking: `searchAvailability`, and for booking, `supportsIdempotency === true` plus `createReservation` accepting a stable idempotency key. Outcome reconciliation requires `getReservationByIdempotencyKey`.
- Durable store: `create`, `get`, `update`; production implementations must be PostgreSQL-backed with concurrency control and append-only audit.
- Task Registry: `createTask`.
- Approval verifier: approval must be bound to the exact immutable proposal digest and action.

## Connected app boundaries
The ChatGPT app connectors are available in this assistant session; their authorization is not automatically transferred to the deployed JARVIS server. A backend integration requires its own supported OAuth/API credentials and secure secret provisioning. No connector token or customer data is copied into this repository.

### iCloud Calendar
- The connected calendar connector exposes calendar listing, event search, create, update, and delete operations.
- Event updates/deletes use the latest event ETag as an optimistic-concurrency check.
- Invitation notifications are opt-in on event mutations; keep them disabled unless a separately approved operation explicitly requests invitations.
- Backend adapter remains unconnected pending a server-side credential/authentication design.

### Todoist
- The connected connector exposes task create/update, due-date scheduling, reminder operations, and task/project reads.
- Use it for reservation preparation tasks and deadline reminders, not as the canonical reservation ledger.
- Backend adapter remains unconnected pending server-side credentials.

### Tripsy
- The connected connector exposes trips, activities, lodging, transportation, and document operations within the authenticated Tripsy account.
- Activity creation requires coordinates; timed activity values use UTC ISO-8601 plus the location's IANA timezone.
- Use it for travel itinerary context, not as a booking provider or source of truth for external booking confirmation.
- Backend adapter remains unconnected pending a supported server-side API/auth contract.

## Wix Bookings as Calendly alternative
- The Wix account connector is authenticated, but the current account returned zero Wix sites. There is no site to configure or attach a public booking page to yet.
- Official Wix Bookings documentation describes service queries, appointment availability slots, a fresh slot-availability check, booking creation, rescheduling, cancellation, and booking-created/rescheduled/updated webhooks.
- The documented appointment flow is: query service → list availability slots → get the selected slot again → create booking.
- Relevant official API methods:
  - [Query Services](https://dev.wix.com/docs/api-reference/business-solutions/bookings/services/services-v2/query-services)
  - [List Availability Time Slots](https://dev.wix.com/docs/api-reference/business-solutions/bookings/time-slots/time-slots-v2/list-availability-time-slots)
  - [Get Availability Time Slot](https://dev.wix.com/docs/api-reference/business-solutions/bookings/time-slots/time-slots-v2/get-availability-time-slot)
  - [Create Booking](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/create-booking)
  - [Reschedule Booking](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/reschedule-booking)
  - [Cancel Booking](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/cancel-booking)
- Wix documents a booking revision on reschedule/cancel and recommends rechecking availability before booking or rescheduling. Booking webhooks can be used for reconciliation.
- The reviewed Create Booking documentation does not establish a provider-side idempotency-key contract. Therefore the Wix adapter must advertise `supportsIdempotency: false` until Wix's exact request contract is verified; the existing agent must fail closed for automatic booking and use an approval-gated human handoff instead.
- Booking creation may initially return `CREATED`; this must not be reported as confirmed without reading the provider's final booking status and reconciling the corresponding webhook.
- No Wix site, service, staff member, booking page, booking, payment, or customer notification has been created or changed.

## Safety rules
- Proposals and availability searches do not create bookings.
- A matching explicit approval is required for a reservation create.
- Payment, cancellation, outbound messages, and irreversible changes require separate action-specific approvals.
- A timeout after request dispatch is `outcome_unknown`; do not retry. Reconcile by provider idempotency key. A provider "not found" response alone is not proof that a delayed request cannot still complete.
- Providers without a verified idempotency contract fail closed.
- Calendar conflicts are checked both at proposal and immediately before booking. This remains a TOCTOU limitation unless the calendar provider supports atomic holds.
- No live calendar, restaurant, hotel, flight, medical, vehicle, or other booking adapter is connected by this PR.
- No external booking, payment, email, SMS, publication, or production write is performed by tests.

## Remaining implementation
1. Wire the PostgreSQL store into the JARVIS runtime behind a disabled-by-default feature flag; require migration 0006 to exist and never auto-migrate production.
2. Add a server-side calendar adapter with its own credentials and ETag-aware conflict/update semantics.
3. Add Todoist and Tripsy backend adapters only after their server-side authentication/API contracts are established.
4. For Wix, select or create a site, install/configure Bookings, create the service catalog and public booking page only after the site owner approves those live changes.
5. Keep Wix booking creation manual/approval-gated until a documented idempotency contract or safe provider-side reconciliation guarantee is proven.
6. Add separate cancellation/reschedule/payment approvals and webhook signature verification, replay protection, and event deduplication.


## Communication decision (Windows PC voice + LINE + Web)
The selected user-facing channels are all three: LINE, Web dashboard, and voice. Windows PC is the primary voice endpoint.
- The existing authenticated Web dashboard is the first shared operator console; existing job APIs remain the task execution source.
- The dashboard now includes opt-in, push-to-talk browser speech recognition (Japanese) and speech synthesis for completed assistant answers. Recognized text is placed into the request field and is NOT submitted automatically; the user must inspect it and press the existing submit button.
- Voice capture is never always-on in this phase. No wake-word detector, background microphone, remote audio streaming, or audio retention is introduced.
- Use a current Windows version of Microsoft Edge or Google Chrome with microphone permission and HTTPS (or localhost for development). Browser support varies; unsupported browsers must fall back to text.
- LINE remains a separate planned ingress/notification adapter; it is not connected to the same conversation/session store by this dashboard change. No LINE webhook, customer message, or production setting is changed.
- A unified conversation/session model across LINE, Web and voice, secure LINE identity mapping, WebSocket/SSE live updates, and cross-channel conversation history remain follow-up work. Do not describe cross-channel synchronization as complete.
- The browser uses the existing JARVIS API token in memory only. Disconnect clears the in-memory token and stops speech capture/playback.
