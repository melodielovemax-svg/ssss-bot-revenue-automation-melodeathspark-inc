import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog } from '../src/audit.mjs'
import { Loyalty, LoyaltyError, UNSUPPORTED } from '../src/loyalty.mjs'

function loyalty() {
  const log = new AuditLog()
  return { log, points: new Loyalty({ log }) }
}

test('earning from a purchase records the spend that sets the tier', () => {
  const { log, points } = loyalty()
  const result = points.earnForPurchase({
    customerId: 'cust_1',
    orderId: 'ord_1',
    total: { asset: 'USD', minor: 49_00n },
    log,
  })
  assert.deepEqual(result, { awarded: true, points: 49n })
  assert.equal(points.balance('cust_1'), 49n)
  assert.equal(points.tier('cust_1').name, 'none')
})

test('a retried webhook does not award points twice', () => {
  const { log, points } = loyalty()
  const args = { customerId: 'c', orderId: 'ord_1', total: { asset: 'USD', minor: 49_00n }, log }
  points.earnForPurchase(args)
  const second = points.earnForPurchase(args)
  assert.equal(second.awarded, false)
  assert.equal(points.balance('c'), 49n)
  assert.equal(log.byType('loyalty.earned').length, 1)
})

test('tier follows lifetime spend, not balance', () => {
  const { log, points } = loyalty()
  // Banked points with no spend must not confer a tier, because a refund would
  // not take them away.
  points.grantContribution({ customerId: 'c', kind: 'bounty', reference: 'b1', points: 100_000 })
  assert.equal(points.balance('c'), 100_000n)
  assert.equal(points.tier('c').name, 'none')

  points.earnForPurchase({ customerId: 'c', orderId: 'ord_1', total: { asset: 'USD', minor: 2_000_00n }, log })
  assert.equal(points.tier('c').name, 'gold')
})

test('contributions outrank purchases and are idempotent per reference', () => {
  const { log, points } = loyalty()
  const first = points.grantContribution({ customerId: 'c', kind: 'accepted_answer', reference: 'q-1', points: 250 })
  assert.deepEqual(first, { awarded: true, points: 250 })

  const repeat = points.grantContribution({ customerId: 'c', kind: 'accepted_answer', reference: 'q-1', points: 250 })
  assert.equal(repeat.awarded, false)
  assert.equal(points.balance('c'), 250n)
  assert.equal(points.contributions('c'), 1)
})

test('rejects an unknown contribution kind and non-positive points', () => {
  const { log, points } = loyalty()
  assert.throws(() => points.grantContribution({ customerId: 'c', kind: 'vibes', reference: 'r', points: 5 }), LoyaltyError)
  assert.throws(() => points.grantContribution({ customerId: 'c', kind: 'review', reference: 'r', points: 0 }), /positive/)
  assert.throws(() => points.grantContribution({ customerId: 'c', kind: 'review', reference: 'r', points: 1.5 }), LoyaltyError)
})

test('a sub-unit purchase awards nothing rather than rounding up', () => {
  const { log, points } = loyalty()
  // 50 minor units is $0.50, below the one-point threshold.
  const result = points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { asset: 'USD', minor: 50n }, log })
  assert.deepEqual(result, { awarded: false, points: 0n })
  assert.equal(log.byType('loyalty.earned').length, 0)
})

test('an amount that went through float arithmetic is refused', () => {
  const { log, points } = loyalty()
  // A Number here means the value was already rounded somewhere upstream,
  // which is the failure this whole package is arranged to prevent.
  assert.throws(
    () => points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { asset: 'USD', minor: 4999 }, log }),
    /must be non-negative bigint/,
  )
  assert.throws(
    () => points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { asset: 'USD', minor: -1n }, log }),
    LoyaltyError,
  )
  assert.throws(
    () => points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { minor: 100n }, log }),
    /total.asset/,
  )
})

test('spending refuses to overdraw', () => {
  const { log, points } = loyalty()
  points.grantContribution({ customerId: 'c', kind: 'review', reference: 'r1', points: 100 })
  assert.deepEqual(points.spend({ customerId: 'c', points: 40n }), { customerId: 'c', points: 40n, remaining: 60n })
  assert.equal(points.balance('c'), 60n)
  assert.throws(() => points.spend({ customerId: 'c', points: 61n }), /balance is 60/)
  assert.throws(() => points.spend({ customerId: 'c', points: 0n }), /positive/)
})

test('spending for an unknown customer is refused', () => {
  const { log, points } = loyalty()
  assert.throws(() => points.spend({ customerId: 'ghost', points: 1n, log }), /balance is 0/)
})

test('discount is integer basis-point arithmetic', () => {
  const { log, points } = loyalty()
  points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { asset: 'USD', minor: 2_000_00n }, log })
  const result = points.discountFor('c', { asset: 'USD', minor: 100_00n })
  assert.equal(result.tier, 'gold')
  assert.equal(result.discountBps, 800)
  assert.equal(result.discount.minor, 8_00n)
  assert.equal(result.payable.minor, 92_00n)
})

test('a zero-tier customer pays full price', () => {
  const { points } = loyalty()
  const result = points.discountFor('new', { asset: 'USD', minor: 100_00n })
  assert.equal(result.discountBps, 0)
  assert.equal(result.payable.minor, 100_00n)
})

test('a discount never exceeds the total', () => {
  const { log, points } = loyalty()
  points.earnForPurchase({ customerId: 'c', orderId: 'o', total: { asset: 'USD', minor: 5_000_00n }, log })
  const tiny = points.discountFor('c', { asset: 'USD', minor: 1n })
  assert.ok(tiny.payable.minor >= 0n)
})

test('rehydrate rebuilds balances, spend and contributions from the log', () => {
  const { log, points } = loyalty()
  points.earnForPurchase({ customerId: 'c', orderId: 'o1', total: { asset: 'USD', minor: 2_000_00n }, log })
  points.grantContribution({ customerId: 'c', kind: 'review', reference: 'r1', points: 75 })
  points.spend({ customerId: 'c', points: 25n })

  // A fresh instance with the same log must reach the same state.
  const restored = new Loyalty({ log }).rehydrate()
  assert.equal(restored.balance('c'), 2_000n + 75n - 25n)
  assert.equal(restored.tier('c').name, 'gold')
  assert.equal(restored.contributions('c'), 1)
})

test('the ledger exposes no withdrawal or transfer path', () => {
  const { points } = loyalty()
  for (const forbidden of ['withdraw', 'redeemCash', 'transfer', 'convert', 'payout']) {
    assert.equal(typeof points[forbidden], 'undefined', `${forbidden} must not exist on the ledger`)
  }
  assert.match(UNSUPPORTED.withdraw, /no cash redemption/)
  assert.match(UNSUPPORTED.transfer, /not transferable/)
  assert.ok(Object.isFrozen(UNSUPPORTED))
})
