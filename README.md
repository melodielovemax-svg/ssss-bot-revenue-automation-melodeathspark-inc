# nexus-store

A digital product storefront with licensing, crypto payments settled through a
compliant processor, and an off-chain loyalty ledger.

This is a working core, not a complete store. What is missing is listed in
STATUS.md, and the parts that would make it a regulated money-transmission
business are deliberately not here.

```bash
npm test          # 67 tests, no network, no dependencies
npm run demo      # one full sale, printed, against a stub processor
```

## What it does

```js
import { AuditLog, Catalog, createOrder, markPaid, Loyalty } from './src/index.mjs'

const log = new AuditLog()
const catalog = new Catalog()

catalog.add({
  sku: 'prompt-engineering-kit',
  title: 'Prompt Engineering Kit',
  kind: 'digital',
  price: { amount: '49.00', asset: 'USD' },
  licence: { tier: 'team', term: 'perpetual', seats: 3 },
})

const order = createOrder({
  cart: [{ product: catalog.get('prompt-engineering-kit') }],
  customer: { id: 'cust_1' },
  processor: { name: 'processor', reference: 'pi_123' },
  log,
})

// After the processor's webhook handler verifies its signature.
const licences = markPaid({
  order,
  confirmation: { processorRef: 'ch_123', chargedAmount: '49.00', asset: 'USD' },
  log,
})
```

`markPaid` refuses to issue a licence unless the amount the processor reports
matches the order total. A store that issues entitlements for money nobody
collected ends up owing refunds it never received.

## The four decisions that matter

**Money is integers only.** Every amount is a `BigInt` of minor units with the
asset's exponent recorded. `toMinor` accepts strings, not numbers, because a
number reaching this code has already been through float arithmetic. `7.111384`
is 7111384 minor units in USDT and would be a rounding error in USD, so the
asset travels with every amount and cross-asset addition throws instead of
guessing a rate.

**State is a projection of the log.** Orders and licences are derived by
`replay(log)`, not stored. The log is what a payment processor's records and an
accountant's ledger can both be reconciled against, and a stored total that
disagrees with the log is detectable rather than authoritative. Each entry
commits to the hash of the one before it.

**Loyalty points buy a discount and nothing else.** No withdrawal, no transfer,
no conversion to any asset. A scheme that promises value for deposits or for
recruiting others is treated as a security or money transmission in most
jurisdictions. A closed discount loop is a loyalty programme, which is not.
`test/loyalty.test.mjs` asserts the withdrawal methods do not exist, because a
policy that is only in a README does not survive a refactor.

**The processor holds the keys.** Crypto is accepted as a payment method settled
by a compliant processor with its own KYC and sanctions screening. No private
keys, no self-custody, no manual transfer confirmation in this codebase.

## Reputation, the "karma" part

Points are also awarded for contribution: a completed bounty, an accepted
review, an accepted answer. That track is worth more per award than spending,
deliberately, because it is the behaviour the ecosystem needs.

It is off-chain. Reputation for contribution belongs to a person or a project,
not to a token, and publishing who-reviewed-what-for-whom to a public ledger
leaks information about real people. Stored inside this store, the points mean
something; published, they would mean something about somebody else.

## Loyalty tiers

| Tier | Lifetime spend | Discount |
| --- | --- | --- |
| none | 0 | 0% |
| bronze | 100.00 | 2% |
| silver | 500.00 | 5% |
| gold | 2 000.00 | 8% |

Tier follows **lifetime spend, not point balance**. A balance can be farmed with
self-purchases and refunds; spend cannot be reversed unless the processor
reverses the money too.

## Legal

`LEGAL.md` records what this project deliberately is not — no token, no staking,
no yield, no referral payouts, no self-custody — and why. The loyalty design is a
closed discount loop specifically because a redemption path to value is treated
as a security or money transmission in most jurisdictions. Not legal advice;
unreviewed.

## Verification

```bash
npm test
```

67 tests. The ones that matter most:

- money: a Number is rejected, extra decimals are rejected, cross-asset
  addition throws, parse/format round-trips
- audit: a rewritten payload fails verification at that entry, a removed entry
  breaks the chain link, entries survive a JSON round trip
- catalog: `addAll` is all-or-nothing, listed prices are deeply frozen, a
  non-perpetual licence without `termDays` is rejected
- orders: a payment mismatch is recorded and does **not** mark the order paid; a
  service line is forced to one seat; a refund revokes the licences; `replay`
  reconstructs everything
- loyalty: a retried webhook cannot double-award, spend is refused when banked
  points are high but spend is low, no withdrawal path exists

The demo script also refuses to overstate itself: it prints what it did not do.

## Licence tiers

`personal`, `single-org`, `team`, `enterprise`, with `seats`, a `term` of
`perpetual` or a `termDays` count, and an explicit `redistribution` flag. Terms
live on the product, so a customer's entitlement is determinable months later
from the product alone, when the original order row is gone.

## Not here

Read STATUS.md before assuming otherwise. Briefly: no HTTP server, no processor
integration, no webhook signature verification, no tax handling, no persistence,
no frontend, no delivery of actual files.

## Read-only Stripe catalog extraction

Install globally with `npm install --global melodeathcli-melodie`, or run once
with `npx melodeathcli-melodie stripe doctor` / `pnpm dlx melodeathcli-melodie stripe doctor`.
The package provides the `melodie` executable and requires Node.js 18 or later.

The `melodie stripe` CLI reads Products, Prices, Payment Links, and Payment Link
line items from Stripe using GET requests only. It never creates or changes
Stripe objects. Authenticate with `stripe login` in the official Stripe CLI, or
set `STRIPE_SECRET_KEY` in the process environment. When using the Stripe CLI,
the extractor forces live mode and removes API-key environment overrides from
the child process. It does not read, create, or overwrite `.env` files.

```bash
melodie stripe doctor
melodie stripe account
melodie stripe extract
melodie stripe products
melodie stripe prices
melodie stripe payment-links
melodie stripe summary
melodie stripe verify
```

`extract` writes timestamped JSON, CSV, evidence, and SHA-256 manifests under
`evidence/stripe/`. It follows Stripe cursors through every page (100 objects
per request), exports archived records, and marks incomplete extraction as
`PARTIAL`. Missing CLI authentication or API credentials produce `BLOCKED`;
sample data is never substituted. `verify` checks the manifest, artifact hashes, and
Product/Price/Payment Link references. The extractor is an import/evidence
stage only: it does not publish products, activate checkout, process payments,
or recognize revenue.

For a local CLI invocation without installing the package, use
`node ./src/cli.mjs stripe <command>`.
For a browser login without exposing an API key in source or `.env`, run
`stripe login` and approve Stripe's device authorization page. This is Stripe
authentication; Google sign-in is only an option on Stripe's own login page if
your Stripe account has enabled it.

## Licence

MIT
