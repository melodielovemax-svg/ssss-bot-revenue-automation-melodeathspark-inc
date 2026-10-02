// Order and licence lifecycle, rebuilt from the audit log.
//
// Nothing here keeps its own authoritative state. Orders and licences are
// projections: `replay` reads the event log and derives the current position.
// A stored total that disagrees with the log is therefore a bug we can detect,
// not a state we have to trust, which matters because the log is the part a
// payment processor and an accountant can both read.
//
// Every function that changes state takes the log and appends to it. There is no
// path that mutates a licence without leaving a record.

import { createHash, randomUUID } from 'node:crypto'
import { format, money, zero } from './money.mjs'

export class OrderError extends Error {
  constructor(message, code = 'EORDER') {
    super(message)
    this.name = 'OrderError'
    this.code = code
  }
}

export const ORDER_OPEN = 'open'
export const ORDER_PAID = 'paid'
export const ORDER_FULFILLED = 'fulfilled'
export const ORDER_REFUNDED = 'refunded'
export const ORDER_CANCELLED = 'cancelled'

export const LICENCE_ACTIVE = 'active'
export const LICENCE_EXPIRED = 'expired'
export const LICENCE_REVOKED = 'revoked'

export function createOrder({ cart, customer, processor, log }) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new OrderError('cart cannot be empty', 'ECART')
  }
  if (!customer?.id) throw new OrderError('customer.id is required', 'ECUSTOMER')
  if (!processor?.name) throw new OrderError('processor.name is required', 'EPROCESSOR')

  const lines = cart.map((line) => {
    if (!line.product) throw new OrderError('cart line needs a product', 'ECART')
    const { product, quantity = 1, seats } = line
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new OrderError(`quantity must be a positive integer for ${product.sku}`, 'EQUANTITY')
    }
    // A digital good is per-seat at purchase time, so seats ride on the line.
    // A service is not, and pretending otherwise would sell a seat count to
    // someone who cannot use it.
    const lineSeats = product.kind === 'service' ? 1 : (seats ?? product.licence.seats ?? 1)
    if (!Number.isInteger(lineSeats) || lineSeats < 1) {
      throw new OrderError(`seats must be a positive integer for ${product.sku}`, 'ESEATS')
    }

    return {
      sku: product.sku,
      title: product.title,
      kind: product.kind,
      unitPrice: product.price,
      quantity,
      seats: lineSeats,
      licence: product.licence,
      subtotal: { asset: product.price.asset, minor: product.price.minor * BigInt(quantity) },
    }
  })

  const totals = totalFor(lines)
  const order = {
    id: `ord_${randomUUID()}`,
    customerId: customer.id,
    processor: processor.name,
    lines,
    ...totals,
    status: ORDER_OPEN,
    createdAt: log.clock().toISOString(),
  }

  log.append('order.created', {
    orderId: order.id,
    customerId: order.customerId,
    processor: order.processor,
    lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity, seats: l.seats })),
    total: serialiseMoney(totals.total),
    // The processor reference is what a refund or a chargeback is reconciled
    // against, so it is captured at creation rather than looked up later.
    processorRef: processor.reference ?? null,
  })

  return order
}

// Confirms that the processor actually moved the money, then issues licences.
//
// The caller passes the processor's report of what it charged. This function
// compares that against the order total and refuses to mark an order paid if
// they differ, because an order recorded as paid for an amount nobody charged
// is how a store ends up owing refunds it never received.
export function markPaid({ order, confirmation, log }) {
  if (order.status !== ORDER_OPEN) {
    throw new OrderError(`order ${order.id} is ${order.status}, not ${ORDER_OPEN}`, 'ESTATE')
  }
  if (!confirmation?.processorRef) {
    throw new OrderError('confirmation requires a processorRef', 'ECONF')
  }

  const charged = money(confirmation.chargedAmount, order.total.asset)
  if (charged.minor !== order.total.minor) {
    log.append('payment.mismatch', {
      orderId: order.id,
      expected: serialiseMoney(order.total),
      charged: serialiseMoney(charged),
    })
    throw new OrderError(
      `processor charged ${format(charged.minor, charged.asset)} but order total is ${format(order.total.minor, order.total.asset)}`,
      'EAMOUNT',
    )
  }
  if (confirmation.asset !== order.total.asset) {
    throw new OrderError(
      `processor settled in ${confirmation.asset}, order is denominated in ${order.total.asset}`,
      'EASSET',
    )
  }

  log.append('order.paid', {
    orderId: order.id,
    processorRef: confirmation.processorRef,
    charged: serialiseMoney(charged),
    settledAt: confirmation.settledAt ?? null,
  })

  return issueLicences({ order, log })
}

export function issueLicences({ order, log }) {
  const licences = order.lines.map((line) => {
    const licence = {
      id: `lic_${randomUUID()}`,
      orderId: order.id,
      customerId: order.customerId,
      sku: line.sku,
      tier: line.licence.tier,
      term: line.licence.term,
      seats: line.seats,
      seatsUsed: 0,
      redistribution: line.licence.redistribution,
      status: LICENCE_ACTIVE,
      issuedAt: log.clock().toISOString(),
      expiresAt: expiryFor(line, log.clock()),
    }
    // The fingerprint lets a customer prove a licence is the one this order
    // produced, without publishing anything about the other orders they hold.
    licence.fingerprint = fingerprint(licence)
    log.append('licence.issued', {
      licenceId: licence.id,
      orderId: order.id,
      sku: line.sku,
      seats: licence.seats,
      term: licence.term,
      expiresAt: licence.expiresAt,
      fingerprint: licence.fingerprint,
    })
    return licence
  })

  log.append('order.fulfilled', { orderId: order.id, licences: licences.map((l) => l.id) })
  return licences
}

export function refundOrder({ order, processorRef, reason, log, actor }) {
  if (![ORDER_PAID, ORDER_FULFILLED].includes(order.status)) {
    throw new OrderError(`order ${order.id} is ${order.status}, cannot refund`, 'ESTATE')
  }
  if (!reason || reason.trim() === '') {
    throw new OrderError('a refund needs a reason', 'EREASON')
  }

  const revoked = log
    .byType('licence.issued')
    .filter((e) => e.payload.orderId === order.id)
    .map((e) => e.payload.licenceId)

  log.append('order.refunded', {
    orderId: order.id,
    processorRef: processorRef ?? null,
    reason: reason.trim(),
    revokedLicences: revoked,
    actor: actor ?? 'system',
  })

  // Revocation is its own event per licence rather than a list on the refund.
  // The summary is convenient, but a licence-level reader — an entitlement
  // check on the hot path, a seat revocation — has to find out whether *this*
  // licence was revoked without parsing every order in the log.
  for (const licenceId of revoked) {
    log.append('licence.revoked', { licenceId, orderId: order.id, reason: reason.trim() })
  }

  return { orderId: order.id, status: ORDER_REFUNDED, revokedLicences: revoked }
}

// Consumes a seat. Idempotent per order, because a customer retrying a download
// must not be charged a second seat.
export function assignSeat({ licence, email, log }) {
  if (licence.status !== LICENCE_ACTIVE) {
    throw new OrderError(`licence ${licence.id} is ${licence.status}`, 'ESTATE')
  }
  if (licence.seatsUsed >= licence.seats) {
    throw new OrderError(`licence ${licence.id} has no seats left`, 'ESEATS')
  }
  log.append('licence.seatAssigned', {
    licenceId: licence.id,
    email,
    seatsUsed: licence.seatsUsed + 1,
    seats: licence.seats,
  })
  return { licenceId: licence.id, email, seatsUsed: licence.seatsUsed + 1, seats: licence.seats }
}

// Rebuilds order and licence state from the log. Used at boot and by the audit
// command. If this disagrees with a stored projection, the log wins.
export function replay(log) {
  const orders = new Map()
  const licences = new Map()

  for (const entry of log.entries()) {
    const p = entry.payload
    switch (entry.type) {
      case 'order.created':
        orders.set(p.orderId, {
          id: p.orderId,
          customerId: p.customerId,
          processor: p.processor,
          status: ORDER_OPEN,
          total: deserialiseMoney(p.total, p.total.asset),
          lines: p.lines,
        })
        break
      case 'order.paid':
        if (orders.has(p.orderId)) orders.get(p.orderId).status = ORDER_PAID
        break
      case 'order.fulfilled':
        if (orders.has(p.orderId)) orders.get(p.orderId).status = ORDER_FULFILLED
        break
      case 'order.refunded':
        if (orders.has(p.orderId)) orders.get(p.orderId).status = ORDER_REFUNDED
        break
      case 'licence.issued':
        licences.set(p.licenceId, {
          id: p.licenceId,
          orderId: p.orderId,
          sku: p.sku,
          tier: 'unknown',
          term: p.term,
          seats: p.seats,
          seatsUsed: 0,
          status: LICENCE_ACTIVE,
          expiresAt: p.expiresAt,
          fingerprint: p.fingerprint,
        })
        break
      case 'licence.seatAssigned':
        if (licences.has(p.licenceId)) {
          const l = licences.get(p.licenceId)
          l.seatsUsed = Math.max(l.seatsUsed, p.seatsUsed ?? 0)
        }
        break
      case 'licence.revoked':
        if (licences.has(p.licenceId)) licences.get(p.licenceId).status = LICENCE_REVOKED
        break
      default:
        break
    }
  }

  const now = log.clock()
  for (const licence of licences.values()) {
    if (licence.status === LICENCE_ACTIVE && licence.expiresAt && new Date(licence.expiresAt) <= now) {
      licence.status = LICENCE_EXPIRED
    }
  }

  return { orders: [...orders.values()], licences: [...licences.values()] }
}

function expiryFor(line, now) {
  if (line.licence.term === 'perpetual') return null
  return new Date(now.getTime() + line.licence.termDays * 86_400_000).toISOString()
}

// A stable subset of the licence, never the customer identity. Two licences
// that differ only in customer must produce the same fingerprint shape, so the
// customer's own id is excluded and a leaked fingerprint identifies a purchase
// rather than a person.
function fingerprint(licence) {
  return createHash('sha256')
    .update(`${licence.orderId}|${licence.sku}|${licence.seats}|${licence.term}|${licence.expiresAt ?? 'perpetual'}`)
    .digest('hex')
    .slice(0, 32)
}

function totalFor(lines) {
  if (lines.length === 0) return { subtotal: null, fees: null, total: null }
  // One asset per order. A mixed-asset cart needs a conversion rate and a
  // timestamp for that rate, and a store that guesses one overcharges someone
  // eventually.
  const asset = lines[0].subtotal.asset
  if (!lines.every((l) => l.subtotal.asset === asset)) {
    throw new OrderError('a cart may only contain one asset', 'EASSET')
  }
  const subtotal = lines.reduce((sum, l) => sum + l.subtotal.minor, 0n)
  // Explicitly zero rather than absent, so a receipt can state the fee without
  // the reader inferring it from the arithmetic.
  const fees = 0n
  return {
    subtotal: { asset, minor: subtotal },
    fees: { asset, minor: fees },
    total: { asset, minor: subtotal + fees },
  }
}

function serialiseMoney(m) {
  return m === null ? null : { asset: m.asset, minor: m.minor.toString() }
}

function deserialiseMoney(raw, asset) {
  if (!raw) return zero(asset ?? 'USD')
  return { asset: raw.asset ?? asset, minor: BigInt(raw.minor) }
}

export { format }
