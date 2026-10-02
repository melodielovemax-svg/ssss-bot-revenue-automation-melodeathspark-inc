// Product catalogue.
//
// Prices are validated at construction, so a product that enters the catalogue
// always has a price in integer minor units of a known asset. Licence terms are
// part of the product, not a side channel: a customer's entitlement has to be
// determinable from the product alone, months later, when a refund dispute
// arrives and the original order row is gone.

import { MoneyError, format, money, zero } from './money.mjs'

const LICENCE_TIERS = new Set(['personal', 'single-org', 'team', 'enterprise'])
const KINDS = new Set(['digital', 'service', 'bundle'])

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export class CatalogError extends Error {
  constructor(message, code = 'ECATALOG') {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

export class Catalog {
  #products = new Map()

  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock
  }

  // `definition.price` is a decimal string, e.g. { amount: '7.111384', asset:
  // 'USDT' }. Parsed here so no caller ever holds an unparsed price.
  add(definition) {
    const product = validate(definition, this.clock())
    if (this.#products.has(product.sku)) {
      throw new CatalogError(`duplicate sku ${product.sku}`, 'EDUPLICATE')
    }
    // Deep-frozen, because a shallow freeze leaves `product.price.minor = 0n`
    // writable and a listed price that can be edited after the fact is not a
    // price.
    this.#products.set(product.sku, deepFreeze(product))
    return product
  }

  addAll(definitions) {
    // Validates everything before mutating, so one bad definition cannot leave
    // a half-populated catalogue behind.
    const validated = definitions.map((d) => validate(d, this.clock()))
    for (const [sku] of validated.map((p) => [p.sku])) {
      if (this.#products.has(sku)) {
        throw new CatalogError(`duplicate sku ${sku}`, 'EDUPLICATE')
      }
    }
    for (const product of validated) this.#products.set(product.sku, deepFreeze(product))
    return this.list()
  }

  get(sku) {
    const product = this.#products.get(sku)
    if (!product) throw new CatalogError(`unknown sku ${sku}`, 'ENOENT')
    return product
  }

  has(sku) {
    return this.#products.has(sku)
  }

  list({ kind, publishedOnly = true } = {}) {
    return [...this.#products.values()]
      .filter((p) => (kind ? p.kind === kind : true))
      .filter((p) => (publishedOnly ? p.published : true))
      .sort((a, b) => a.sku.localeCompare(b.sku))
  }

  priceOf(sku) {
    return this.get(sku).price
  }
}

function validate(definition, listedAt) {
  if (!definition || typeof definition !== 'object') {
    throw new CatalogError('product definition must be an object', 'EINVALID')
  }

  const { sku, title, kind, price, licence, delivery } = definition

  if (typeof sku !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(sku)) {
    throw new CatalogError(`invalid sku ${JSON.stringify(sku)}`, 'ESKU')
  }
  if (typeof title !== 'string' || title.trim() === '') {
    throw new CatalogError(`${sku} needs a title`, 'ETITLE')
  }
  if (!KINDS.has(kind)) {
    throw new CatalogError(`${sku} has unknown kind ${kind}`, 'EKIND')
  }

  let parsedPrice
  try {
    parsedPrice = money(String(price.amount), price.asset)
  } catch (err) {
    // MoneyError text is specific about which decimal place was wrong; keep it.
    throw new CatalogError(`${sku}: ${err.message}`, err.code ?? 'EPRICE')
  }
  if (parsedPrice.minor < 0n) {
    throw new CatalogError(`${sku} price cannot be negative`, 'EPRICE')
  }

  if (!licence || typeof licence !== 'object') {
    throw new CatalogError(`${sku} needs licence terms`, 'ELICENCE')
  }
  if (!LICENCE_TIERS.has(licence.tier)) {
    throw new CatalogError(`${sku} has unknown licence tier ${licence.tier}`, 'ETIER')
  }
  if (licence.seats !== undefined && (!Number.isInteger(licence.seats) || licence.seats < 1)) {
    throw new CatalogError(`${sku} seats must be a positive integer`, 'ESEATS')
  }
  // A perpetual licence is the default because it is the only term that needs
  // no renewal date; anything else must state when it lapses.
  if (licence.term !== 'perpetual' && typeof licence.termDays !== 'number') {
    throw new CatalogError(`${sku} non-perpetual licence needs termDays`, 'ETERM')
  }

  if (delivery && delivery.retrievalUrl && !/^https:\/\//.test(delivery.retrievalUrl)) {
    // http delivery would put a purchased download behind an unencrypted hop.
    throw new CatalogError(`${sku} retrievalUrl must be https`, 'EDELIVERY')
  }

  const published = definition.published !== false
  return {
    sku,
    title: title.trim(),
    kind,
    price: parsedPrice,
    licence: Object.freeze({
      tier: licence.tier,
      term: licence.term ?? 'perpetual',
      termDays: licence.termDays ?? null,
      seats: licence.seats ?? null,
      redistribution: licence.redistribution === true,
    }),
    delivery: Object.freeze({ retrievalUrl: delivery?.retrievalUrl ?? null }),
    published,
    // Recorded so the catalogue can be sorted by what is new, and so a
    // reproduction can show which catalogue version produced a given order.
    listedAt: listedAt.toISOString(),
  }
}

// Summarises a selection for a receipt or an order line. Returns display
// strings alongside the numeric amount, because a receipt that shows only
// minor units is unreadable and one that shows only a float is unpayable.
export function describe(product) {
  return `${product.title} — ${format(product.price.minor, product.price.asset)} ${product.price.asset} (${product.licence.tier}, ${product.licence.term})`
}

export { format, zero, MoneyError }
