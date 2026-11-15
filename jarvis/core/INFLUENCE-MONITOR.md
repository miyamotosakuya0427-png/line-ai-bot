# ONE JARVIS Influence Monitor

This module is a provenance-first event intake and durable archive for market-relevant public statements. It does not scrape platforms, bypass access controls, or place orders.

## Supported normalized sources
- `x`: X official API / authorized feed
- `truth_social`: Truth API / licensed feed
- `official_web`, `sec`, `press_release`: official web and disclosure sources
- `other`: explicitly marked source requiring review

Every record stores author, handle, platform, source ID, original timestamp, observed timestamp, HTTPS source URL, verification class, language, original text, and a stable SHA-256 deduplication key. Repeated delivery is idempotent. The JSONL journal is append-only, fsynced, bounded, and fails closed on corruption or write errors.

## API integration contract
The authenticated JARVIS API will expose event intake and read-only event listing. Only the owner-authorized ingestion process should submit records. `verification` describes provenance, not truth or factual accuracy.

## Analysis and trading policy
- Do not interpret a post as a trade signal solely from sentiment.
- Separate factual claims, policy proposals, jokes/sarcasm, opinions, reposts, corrections, deletions, and unverified claims.
- Resolve entities and affected instruments; retain the original source and timestamp.
- Join events to market data using only information available at that time (no look-ahead).
- Backtest with realistic latency, spread, slippage, fees, trading hours, and delayed-feed assumptions.
- Record event-driven hypotheses and results in paper trading first.
- Real-money execution remains disabled. No broker order endpoint is implemented.

## Provider limitations
X and Truth Social access is subject to their current official API plans, terms, rate limits, licensing and cost. No unofficial scraping or account credential collection is supported. An operator must configure provider credentials and approved access separately. The monitor cannot promise literally zero latency or permanent provider availability.
