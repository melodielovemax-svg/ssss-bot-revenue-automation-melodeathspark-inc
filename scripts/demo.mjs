// A full sale, start to finish, against a stub processor.
//
// This is the executable version of what the README claims. It prints the
// ledger, so the claim can be checked by reading output rather than by trusting
// a description of it.
//
// The processor here is a stub that settles instantly and holds no keys. That is
// the only honest way to demonstrate the flow without a live account: a real
// integration goes through a hosted checkout page and a webhook, and the
// webhook's signature check is the part that has no substitute.

import { AuditLog, Catalog, createOrder, markPaid, refundOrder, replay, Loyalty } from '../src/index.mjs'

const log = new AuditLog()

const catalog = new Catalog()
catalog.addAll([
  {
    sku: 'prompt-engineering-kit',
    title: 'Prompt Engineering Kit',
    kind: 'digital',
    price: { amount: '49.00', asset: 'USD' },
    licence: { tier: 'team', term: 'perpetual', seats: 3 },
    delivery: { retrievalUrl: 'https://cdn.example/kit.zip' },
  },
  {
    sku: 'architecture-review',
    title: 'Architecture Review (1 hour)',
    kind: 'service',
    price: { amount: '1200.00', asset: 'USD' },
    licence: { tier: 'enterprise', term: 'perpetual' },
  },
  {
    sku: 'token-budget-pack',
    title: 'Token Budget Pack',
    kind: 'digital',
    price: { amount: '7.111384', asset: 'USDT' },
    licence: { tier: 'personal', term: 'annual', termDays: 365 },
  },
])

const product = catalog.get('prompt-engineering-kit')
const service = catalog.get('architecture-review')

const order = createOrder({
  cart: [{ product, quantity: 1 }],
  customer: { id: 'cust_demo', email: 'demo@example.com' },
  processor: { name: 'stub-processor', reference: 'pi_demo' },
  log,
})

// Pretend this arrived from the processor's webhook handler.
const confirmation = { processorRef: 'ch_demo', chargedAmount: '49.00', asset: 'USD', settledAt: log.clock().toISOString() }

const licences = markPaid({ order, confirmation, log })

console.log('catalogue')
for (const p of catalog.list()) {
  console.log(`  ${p.sku.padEnd(26)} ${p.licence.tier.padEnd(11)} ${p.price.minor} ${p.price.asset} minor units`)
}
console.log(`  service line priced at ${service.price.minor} minor units, one seat per unit`)

console.log('\norder')
console.log(`  ${order.id}`)
console.log(`  total      ${order.total.minor} ${order.total.asset} minor units`)
console.log(`  fees       ${order.fees.minor} ${order.fees.asset} (explicit, so a receipt can state it)`)

console.log('\nlicences issued')
for (const l of licences) {
  console.log(`  ${l.id}  seats ${l.seats}  term ${l.term}  expires ${l.expiresAt ?? 'never'}`)
  console.log(`  fingerprint ${l.fingerprint}`)
}

const loyalty = new Loyalty({ log })
const award = loyalty.earnForPurchase({ customerId: 'cust_demo', orderId: order.id, total: order.total, log })
const bounty = loyalty.grantContribution({
  customerId: 'cust_demo',
  kind: 'accepted_answer',
  reference: 'q-1',
  points: 250,
  log,
})
const quoted = loyalty.discountFor('cust_demo', order.total)

console.log('\nloyalty (off-chain, discount-only)')
console.log(`  purchase award   ${award.points} points`)
console.log(`  contribution     ${bounty.points} points for an accepted answer`)
console.log(`  balance          ${loyalty.balance('cust_demo')}`)
console.log(`  tier             ${quoted.tier} (${quoted.discountBps} bps)`)
console.log(`  next 100.00 USD would cost ${100_00n - quoted.discount.minor} USD minor units`)
console.log('  no withdrawal, transfer, or conversion path exists')

const refund = refundOrder({
  order: { ...order, status: 'fulfilled' },
  processorRef: 're_demo',
  reason: 'customer request within 14 days',
  actor: 'support@nexus',
  log,
})
console.log(`\nrefund  ${refund.status}, revoked ${refund.revokedLicences.length} licence(s)`)

const state = replay(log)
console.log(`replay  order is now ${state.orders[0].status}, licence is ${state.licences[0].status}`)

const integrity = log.verify()
console.log(`chain   ok=${integrity.ok} head=${integrity.head.slice(0, 16)}... entries=${log.entries().length}`)

console.log('\nwhat this did not do')
console.log('  no payment processor was called and no money moved')
console.log('  no webhook signature was verified, because no webhook arrived')
console.log('  no tax, invoice, or regulatory record was produced')
