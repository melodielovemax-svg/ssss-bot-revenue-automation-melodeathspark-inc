# STATUS

Last updated: 2026-10-01

This is a working core of a storefront, not a store. It has 67 passing tests, no
dependencies, and no network access. It cannot take money from anyone yet,
because the part that would be required for that is not written.

## What works, verified by test

| | |
|---|---|
| Money | Integer minor units as `BigInt`, asset exponent carried, strings in, cross-asset addition refused |
| Catalogue | Validated products, deep-frozen prices, all-or-nothing bulk add, licence terms validated at listing |
| Orders | Cart, total, one asset per order, service lines forced to one seat |
| Payment gate | `markPaid` compares the processor's report against the order total and refuses on mismatch |
| Licences | Issued per line, fingerprint, expiry for term licences, seat assignment, revocation on refund |
| Refunds | Requires a reason and an actor, revokes every licence from the order |
| Loyalty | Purchase and contribution awards, idempotent per order and per reference, basis-point discounts, tier from lifetime spend |
| Audit log | Append-only, hash-chained, deeply frozen, `verifyEntries` for a log read back from a file |
| Recovery | `replay(log)` rebuilds orders and licences from the log alone |
| Stripe catalog extraction | Read-only Products, Prices, Payment Links and line-item pagination; timestamped JSON/CSV evidence and SHA-256 verification |

## What is missing, and which of these block taking money

**Blocks taking money, in order:**

1. **No payment processor integration.** The Stripe catalog extractor uses
   read-only GET requests; it does not create checkout sessions, payment
   intents, or Payment Links and cannot produce a payment confirmation.
2. **No webhook signature verification.** This is the single most important
   missing piece. A webhook handler that trusts its payload lets anyone POST a
   "payment succeeded" message and receive a licence for free. The signature
   check is not optional and cannot be stubbed.
3. **No persistence.** The log lives in memory and dies with the process. Order
   history, licence state and loyalty balances are all lost on restart. `replay`
   proves the projection is derivable; nothing writes it anywhere.
4. **No authentication or authorisation.** There is no notion of who is calling
   `markPaid`, and no customer identity model beyond a string id.
5. **No delivery.** Licences are issued as data. Nothing serves the product
   behind `delivery.retrievalUrl`, and no access control runs at download time.
6. **No HTTP server, no frontend.** This is a library. There is no cart page, no
   checkout page, no account area.

The Stripe extractor is strictly a discovery/import stage. It never writes to
Stripe and never treats imported products, Payment Links, or catalog evidence
as approval to publish or sell.

**Required before operating, not implemented:**

7. **No tax handling.** Prices exclude tax, refunds ignore it, and no record is
   produced. Digital goods are taxed differently in most places and the rate
   depends on the customer's location.
8. **No receipts or invoices.** Nothing renders a receipt, and the data needed
   for one is in the log but unused.
9. **No refund reconciliation.** A refund records a processor reference; nothing
   checks the processor actually processed it, so a failed refund is invisible.
10. **No rate limiting, no abuse controls, no CSRF.** None of these exist because
    there is no server to attack yet.
11. **No data retention or deletion path.** Customer records are kept forever.

## Legal scope, stated plainly

**This is a loyalty programme, not an investment product.** Points buy a
percentage discount and cannot be withdrawn, transferred, or converted. That is
deliberate and it is what keeps the design out of securities and money
transmission regulation, which most jurisdictions treat seriously. Adding any
redemption-to-value path changes the legal analysis completely, and that is a
decision for a lawyer in the relevant jurisdictions, not a code change.

**"Crypto payments" means a compliant processor settles them.** No private keys
are held, no self-custody, no manual confirmation step. The store takes
instructions; the processor does KYC, sanctions screening and settlement. If the
processor will not serve the jurisdiction, the answer is that the store does not
operate there. That is a business fact, not a technical one.

**No token, no staking, no yield, no DAO, no vesting.** None of that is here and
none of it is planned in this repository. If it were added, the regulatory
treatment changes and this document would be wrong.

**Not legal advice.** Nothing here has been reviewed by a lawyer. Whether a
specific product, price, refund policy and loyalty scheme can lawfully operate
in a given jurisdiction is a question for a lawyer in that jurisdiction.

## Technical limitations

- **The hash chain is tamper-evident, not tamper-resistant.** Anyone who can
  rewrite the log file can rewrite the chain with it. Detecting that requires
  anchoring the head hash somewhere the attacker cannot reach: a notary, a
  transparency log, another party's copy. Not implemented.
- **`replay` is O(log size) on every call.** Fine at this scale, wrong at
  100k events. Snapshots or incremental projection are needed.
- **Loyalty has no expiry implemented.** `UNSUPPORTED.expire` documents the
  intent and no code enforces it.
- **Licence tiers are named, not differentiated.** `personal` and `enterprise`
  carry the same fields; no feature gating is attached to them.
- **Fingerprint is a hash of licence fields, not a signature.** It identifies a
  purchase; it does not prove authenticity to a third party.
- **Single-process, single-tenant, no concurrency control.** Two concurrent
  purchases can race on seat assignment.
- **No localisation, no multi-currency pricing.** One asset per order.

## Reproducing

```
npm test
npm run demo
```

The demo prints a full sale: catalogue, order, licences, loyalty arithmetic, a
refund, a replay, and the chain head. It also prints what it did not do — no
processor was called, no webhook arrived, no tax record was produced.
