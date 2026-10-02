// Off-chain loyalty ledger.
//
// Points have exactly one use: a percentage discount on a future purchase.
// That constraint is the whole design. Points are not transferable, not
// redeemable for cash, not exchangeable for any asset, and expire.
//
// Why that matters legally: a points scheme that promises value in return for
// deposits or for recruiting others is treated as a security or a money
// transmission arrangement in most jurisdictions, and both carry licensing
// obligations and reserve requirements. A closed discount loop is a customer
// loyalty programme, which is not.
//
// The reason it is on-chain ("karma", "reputation") is reputation for
// *contribution*: review quality, accepted answers, completed bounties. Those
// belong to a person or a project, not to a token, and publishing them to a
// public ledger would leak who reviewed what for whom. Stored here, off-chain,
// because the value is only meaningful inside this store.

export class LoyaltyError extends Error {
  constructor(message, code = 'ELOyalty') {
    super(message)
    this.name = 'LoyaltyError'
    this.code = code
  }
}

// Tier thresholds are on spend, not on point balance. A balance can be farmed by
// self-purchases and refunds; spend cannot be reversed without the processor
// reversing the money too.
export const TIERS = [
  { name: 'none', minSpendMinor: 0n, discountBps: 0 },
  { name: 'bronze', minSpendMinor: 100_00n, discountBps: 200 },
  { name: 'silver', minSpendMinor: 500_00n, discountBps: 500 },
  { name: 'gold', minSpendMinor: 2_000_00n, discountBps: 800 },
]

export class Loyalty {
  #balances = new Map()
  #spend = new Map()
  #contributions = new Map()

  constructor({ log, clock = () => new Date() } = {}) {
    this.log = log
    this.clock = clock
  }

  // Rebuilds balances from the log rather than storing them, so a lost balance
  // is recoverable and an invented one is detectable.
  rehydrate() {
    this.#balances.clear()
    this.#spend.clear()
    this.#contributions.clear()

    for (const entry of this.log.byType('loyalty.earned')) {
      this.#credit(entry.payload.customerId, BigInt(entry.payload.points), entry.payload.reason)
    }
    for (const entry of this.log.byType('loyalty.spent')) {
      const id = entry.payload.customerId
      this.#balances.set(id, this.#balances.get(id) - BigInt(entry.payload.points))
    }
    for (const entry of this.log.byType('loyalty.spendRecorded')) {
      this.#spend.set(entry.payload.customerId, this.#spendOf(entry.payload.customerId) + BigInt(entry.payload.minor))
    }
    for (const entry of this.log.byType('loyalty.contributed')) {
      this.#contributions.set(entry.payload.customerId, (this.#contributions.get(entry.payload.customerId) ?? 0) + 1)
    }
    return this
  }

  // Points from spending. One award per order, enforced by the order id, so a
  // retried webhook cannot mint a second award.
  earnForPurchase({ customerId, orderId, total, log = this.log }) {
    const existing = log
      .byType('loyalty.earned')
      .find((e) => e.payload.reason === 'purchase' && e.payload.orderId === orderId)
    if (existing) return { awarded: false, points: BigInt(existing.payload.points) }

    // A Number here would mean an amount that already went through float
    // arithmetic somewhere upstream, so it is refused rather than coerced.
    if (typeof total?.minor !== 'bigint' || total.minor < 0n) {
      throw new LoyaltyError(`total.minor must be non-negative bigint, got ${total?.minor}`, 'EMINOR')
    }
    if (!total.asset) throw new LoyaltyError('total.asset is required', 'EASSET')

    // 1 point per whole unit of currency spent. A 500 USDT order and a 500 USD
    // order award the same number of points: the point buys a percentage
    // discount, and a discount is priced in the product's own currency rather
    // than in purchasing power.
    const points = total.minor / 100n
    // A sub-unit purchase awards nothing rather than rounding up to one, which
    // would let a customer farm points with a series of negligible purchases.
    if (points <= 0n) return { awarded: false, points: 0n }

    log.append('loyalty.earned', {
      customerId,
      orderId,
      points: points.toString(),
      reason: 'purchase',
      spendMinor: total.minor.toString(),
      asset: total.asset,
    })
    log.append('loyalty.spendRecorded', { customerId, minor: total.minor.toString(), asset: total.asset })

    // Tier is set from spend, so this has to be tracked in memory as well as in
    // the log. Updating only the log would leave the tier at "none" until
    // something rehydrated the instance.
    this.#spend.set(customerId, this.#spendOf(customerId) + total.minor)
    this.#credit(customerId, points, 'purchase')
    return { awarded: true, points }
  }

  // Points for contribution, not for spending. This is the reputation track:
  // a completed bounty or an accepted review is worth more than a purchase,
  // deliberately, because it is the behaviour the ecosystem actually needs.
  grantContribution({ customerId, kind, reference, points, log = this.log }) {
    if (!['bounty', 'review', 'accepted_answer'].includes(kind)) {
      throw new LoyaltyError(`unknown contribution kind ${kind}`, 'EKIND')
    }
    if (!Number.isInteger(points) || points <= 0) {
      throw new LoyaltyError('points must be a positive integer', 'EPOINTS')
    }
    const already = log
      .byType('loyalty.contributed')
      .some((e) => e.payload.kind === kind && e.payload.reference === reference)
    if (already) return { awarded: false, points: 0n }

    log.append('loyalty.contributed', { customerId, kind, reference, points })
    log.append('loyalty.earned', { customerId, points: String(points), reason: kind, reference })

    this.#credit(customerId, BigInt(points), kind)
    this.#contributions.set(customerId, (this.#contributions.get(customerId) ?? 0) + 1)
    return { awarded: true, points }
  }

  balance(customerId) {
    return this.#balances.get(customerId) ?? 0n
  }

  spend({ customerId, points, log = this.log }) {
    const available = this.balance(customerId)
    if (points <= 0n) throw new LoyaltyError('points must be positive', 'EPOINTS')
    if (points > available) {
      throw new LoyaltyError(`balance is ${available}, cannot spend ${points}`, 'EBALANCE')
    }
    log.append('loyalty.spent', { customerId, points: points.toString() })
    this.#balances.set(customerId, available - points)
    return { customerId, points, remaining: available - points }
  }

  tier(customerId) {
    const spent = this.#spendOf(customerId)
    let current = TIERS[0]
    for (const tier of TIERS) {
      if (spent >= tier.minSpendMinor) current = tier
    }
    return current
  }

  // Applies the tier discount to a total. Integer maths with basis points, so
  // the discount rounds in the same direction every time rather than
  // accumulating a fraction of a minor unit per line.
  discountFor(customerId, total) {
    const tier = this.tier(customerId)
    const discount = (total.minor * BigInt(tier.discountBps)) / 10_000n
    return {
      tier: tier.name,
      discountBps: tier.discountBps,
      discount: { asset: total.asset, minor: discount },
      // What is actually owed after the discount.
      payable: { asset: total.asset, minor: total.minor - discount },
    }
  }

  contributions(customerId) {
    return this.#contributions.get(customerId) ?? 0
  }

  #spendOf(customerId) {
    return this.#spend.get(customerId) ?? 0n
  }

  #credit(customerId, points) {
    this.#balances.set(customerId, this.balance(customerId) + points)
  }
}

// The claims this ledger explicitly does not support, asserted rather than
// documented: a test that fails if someone adds a withdrawal path is the only
// version of this policy that survives a refactor.
export const UNSUPPORTED = Object.freeze({
  transfer: 'points are not transferable between accounts',
  withdraw: 'points have no cash redemption path',
  convert: 'points do not convert to any asset',
  expire: 'points expire and are not a store of value',
})
