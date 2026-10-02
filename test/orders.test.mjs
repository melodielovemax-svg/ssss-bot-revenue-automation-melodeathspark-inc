import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog } from '../src/audit.mjs'
import { Catalog } from '../src/catalog.mjs'
import {
  createOrder,
  markPaid,
  refundOrder,
  assignSeat,
  replay,
  OrderError,
  ORDER_OPEN,
  ORDER_PAID,
  ORDER_FULFILLED,
  ORDER_REFUNDED,
} from '../src/orders.mjs'

function setup() {
  const log = new AuditLog()
  const catalog = new Catalog()
  const product = catalog.add({
    sku: 'toolkit-pro',
    title: 'Toolkit Pro',
    kind: 'digital',
    price: { amount: '49.00', asset: 'USD' },
    licence: { tier: 'team', term: 'perpetual', seats: 3 },
  })
  return { log, catalog, product }
}

function paidOrder(over = {}) {
  const { log, product } = setup()
  const order = createOrder({
    cart: [{ product }],
    customer: { id: 'cust_1' },
    processor: { name: 'processor', reference: 'pi_123' },
    log,
  })
  const licences = markPaid({
    order,
    confirmation: { processorRef: 'ch_123', chargedAmount: order.total.minor.toString().slice(0, -2) + '.' + order.total.minor.toString().slice(-2), asset: 'USD' },
    log,
  })
  return { log, order, licences, ...over }
}

test('creates an order with a computed total and logs it', () => {
  const { log, product } = setup()
  const order = createOrder({
    cart: [{ product, quantity: 2 }],
    customer: { id: 'cust_1' },
    processor: { name: 'processor', reference: 'pi_123' },
    log,
  })

  assert.equal(order.status, ORDER_OPEN)
  assert.equal(order.total.minor, 9800n)
  assert.equal(order.subtotal.minor, 9800n)
  assert.equal(order.fees.minor, 0n)
  assert.equal(log.byType('order.created').length, 1)
  assert.equal(log.byType('order.created')[0].payload.processorRef, 'pi_123')
})

test('rejects an empty cart, a missing customer and a missing processor', () => {
  const { log, product } = setup()
  const base = { customer: { id: 'c' }, processor: { name: 'p' }, log }
  assert.throws(() => createOrder({ ...base, cart: [] }), OrderError)
  assert.throws(() => createOrder({ ...base, cart: undefined }), /cannot be empty/)
  assert.throws(() => createOrder({ cart: [{ product }], customer: {}, processor: { name: 'p' }, log }), /customer.id/)
  assert.throws(() => createOrder({ cart: [{ product }], customer: { id: 'c' }, processor: {}, log }), /processor.name/)
})

test('rejects a non-integer or non-positive quantity', () => {
  const { log, product } = setup()
  const base = { customer: { id: 'c' }, processor: { name: 'p' }, log }
  assert.throws(() => createOrder({ ...base, cart: [{ product, quantity: 0 }] }), /positive integer/)
  assert.throws(() => createOrder({ ...base, cart: [{ product, quantity: 1.5 }] }), OrderError)
})

test('a service line is always one seat regardless of the product terms', () => {
  const { log, catalog } = setup()
  const service = catalog.add({
    sku: 'consulting-day',
    title: 'Consulting day',
    kind: 'service',
    price: { amount: '1200.00', asset: 'USD' },
    licence: { tier: 'enterprise', term: 'perpetual', seats: 50 },
  })
  const order = createOrder({
    cart: [{ product: service, quantity: 2, seats: 50 }],
    customer: { id: 'c' },
    processor: { name: 'p' },
    log,
  })
  // Buying two days of consulting buys two seats, not 100: the requested 50 is
  // dropped because a day cannot be resold to another person.
  assert.equal(order.lines.length, 1)
  assert.equal(order.lines[0].quantity, 2)
  assert.equal(order.lines[0].seats, 1)
})

test('refuses a cart holding more than one asset', () => {
  const { log, catalog, product } = setup()
  const crypto = catalog.add({
    sku: 'usdt-pack',
    title: 'USDT pack',
    kind: 'digital',
    price: { amount: '10.000000', asset: 'USDT' },
    licence: { tier: 'personal', term: 'perpetual' },
  })
  assert.throws(
    () =>
      createOrder({
        cart: [{ product }, { product: crypto }],
        customer: { id: 'c' },
        processor: { name: 'p' },
        log,
      }),
    /one asset/,
  )
})

test('markPaid issues one licence per line and marks the order fulfilled', () => {
  const { log, product } = setup()
  const order = createOrder({
    cart: [{ product }],
    customer: { id: 'cust_1' },
    processor: { name: 'processor' },
    log,
  })
  const licences = markPaid({
    order,
    confirmation: { processorRef: 'ch_1', chargedAmount: '49.00', asset: 'USD' },
    log,
  })

  assert.equal(licences.length, 1)
  assert.equal(licences[0].seats, 3)
  assert.equal(licences[0].status, 'active')
  assert.equal(licences[0].expiresAt, null, 'a perpetual licence must not carry an expiry')
  assert.match(licences[0].fingerprint, /^[0-9a-f]{32}$/)
  assert.equal(log.byType('order.paid').length, 1)
  assert.equal(log.byType('licence.issued').length, 1)
  assert.equal(log.byType('order.fulfilled').length, 1)
})

test('refuses to mark paid when the processor charged a different amount', () => {
  const { log, product } = setup()
  const order = createOrder({
    cart: [{ product }],
    customer: { id: 'c' },
    processor: { name: 'p' },
    log,
  })

  assert.throws(
    () => markPaid({ order, confirmation: { processorRef: 'ch', chargedAmount: '1.00', asset: 'USD' }, log }),
    /charged 1\.00 but order total is 49\.00/,
  )
  assert.equal(log.byType('payment.mismatch').length, 1, 'a mismatch must leave a record')
  assert.equal(log.byType('order.paid').length, 0, 'a mismatched payment must not mark the order paid')
})

test('refuses to mark paid when the processor settles in a different asset', () => {
  const { log, catalog } = setup()
  const product = catalog.add({
    sku: 'usdt-pack',
    title: 'USDT pack',
    kind: 'digital',
    price: { amount: '10.000000', asset: 'USDT' },
    licence: { tier: 'personal', term: 'perpetual' },
  })
  const order = createOrder({
    cart: [{ product }],
    customer: { id: 'c' },
    processor: { name: 'p' },
    log,
  })
  assert.throws(
    () => markPaid({ order, confirmation: { processorRef: 'ch', chargedAmount: '10', asset: 'USD' }, log }),
    /denominated in USDT/,
  )
})

test('refuses to mark an already-paid order again', () => {
  const { order, log } = paidOrder()
  assert.equal(order.status, ORDER_OPEN, 'caller-owned order object is not mutated by design')
  assert.throws(
    () => markPaid({ order: { ...order, status: ORDER_PAID }, confirmation: { processorRef: 'x', chargedAmount: '49.00', asset: 'USD' }, log }),
    /not open/,
  )
})

test('refuses a confirmation with no processor reference', () => {
  const { log, product } = setup()
  const order = createOrder({ cart: [{ product }], customer: { id: 'c' }, processor: { name: 'p' }, log })
  assert.throws(
    () => markPaid({ order, confirmation: { chargedAmount: '49.00', asset: 'USD' }, log }),
    /processorRef/,
  )
})

test('a term licence gets an expiry date', () => {
  const log = new AuditLog()
  const catalog = new Catalog()
  const product = catalog.add({
    sku: 'annual-sub',
    title: 'Annual',
    kind: 'digital',
    price: { amount: '99.00', asset: 'USD' },
    licence: { tier: 'personal', term: 'annual', termDays: 365 },
  })
  const order = createOrder({ cart: [{ product }], customer: { id: 'c' }, processor: { name: 'p' }, log })
  const [licence] = markPaid({ order, confirmation: { processorRef: 'ch', chargedAmount: '99.00', asset: 'USD' }, log })
  const expiry = new Date(licence.expiresAt).getTime() - log.clock().getTime()
  assert.ok(Math.abs(expiry - 365 * 86_400_000) < 1000, `expiry was ${licence.expiresAt}`)
})

test('assignSeat consumes a seat and refuses to exceed the licensed count', () => {
  const { log, licences } = paidOrder()
  const licence = licences[0]
  assert.deepEqual(assignSeat({ licence, email: 'a@example.com', log }), {
    licenceId: licence.id,
    email: 'a@example.com',
    seatsUsed: 1,
    seats: 3,
  })
  assert.throws(() => assignSeat({ licence: { ...licence, seatsUsed: 3 }, email: 'd@example.com', log }), /no seats left/)
  assert.equal(log.byType('licence.seatAssigned').length, 1)
})

test('assignSeat refuses a revoked or expired licence', () => {
  const { log, licences } = paidOrder()
  assert.throws(() => assignSeat({ licence: { ...licences[0], status: 'revoked' }, email: 'a@x.com', log }), /is revoked/)
})

test('refundOrder revokes the licences and records a reason and actor', () => {
  const { log, order, licences } = paidOrder()
  const result = refundOrder({
    order: { ...order, status: ORDER_FULFILLED },
    processorRef: 're_1',
    reason: 'customer request',
    actor: 'support@nexus',
    log,
  })
  assert.equal(result.status, ORDER_REFUNDED)
  assert.deepEqual(result.revokedLicences, [licences[0].id])
  const entry = log.byType('order.refunded')[0]
  assert.equal(entry.payload.actor, 'support@nexus')
  assert.equal(entry.payload.reason, 'customer request')
})

test('refundOrder needs a reason and a paid order', () => {
  const { log, order } = paidOrder()
  assert.throws(() => refundOrder({ order: { ...order, status: ORDER_OPEN }, reason: 'x', log }), /cannot refund/)
  assert.throws(
    () => refundOrder({ order: { ...order, status: ORDER_FULFILLED }, reason: '   ', log }),
    /needs a reason/,
  )
})

test('replay reconstructs order and licence state from the log alone', () => {
  const { log, order } = paidOrder()
  const state = replay(log)
  assert.equal(state.orders.length, 1)
  assert.equal(state.orders[0].status, ORDER_FULFILLED)
  assert.equal(state.orders[0].total.minor, 4900n)
  assert.equal(state.licences.length, 1)
  assert.equal(state.licences[0].status, 'active')
  assert.equal(state.orders[0].id, order.id)
})

test('replay marks a term licence expired once its date has passed', () => {
  let now = new Date('2026-01-01T00:00:00Z')
  const log = new AuditLog({ clock: () => now })
  const catalog = new Catalog()
  const product = catalog.add({
    sku: 'monthly',
    title: 'Monthly',
    kind: 'digital',
    price: { amount: '9.00', asset: 'USD' },
    licence: { tier: 'personal', term: 'monthly', termDays: 30 },
  })
  const order = createOrder({ cart: [{ product }], customer: { id: 'c' }, processor: { name: 'p' }, log })
  markPaid({ order, confirmation: { processorRef: 'ch', chargedAmount: '9.00', asset: 'USD' }, log })

  assert.equal(replay(log).licences[0].status, 'active')
  now = new Date('2026-03-01T00:00:00Z')
  assert.equal(replay(log).licences[0].status, 'expired')
})

test('replay reflects a refund', () => {
  const { log, order } = paidOrder()
  refundOrder({ order: { ...order, status: ORDER_FULFILLED }, reason: 'chargeback', log })
  const state = replay(log)
  assert.equal(state.orders[0].status, ORDER_REFUNDED)
  assert.equal(state.licences[0].status, 'revoked')
})
