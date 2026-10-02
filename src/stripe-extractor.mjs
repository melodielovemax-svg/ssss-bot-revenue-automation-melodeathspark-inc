import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const STRIPE_EXTRACTOR_VERSION = '1.0.0'
const STRIPE_API = 'https://api.stripe.com/v1'
const PAGE_SIZE = 100

export class StripeExtractorError extends Error {
  constructor(message, { code = 'ESTRIPE', status = null } = {}) {
    super(message)
    this.name = 'StripeExtractorError'
    this.code = code
    this.status = status
  }
}

export class StripeClient {
  constructor({ secretKey = process.env.STRIPE_SECRET_KEY, fetchImpl = fetch } = {}) {
    if (typeof secretKey !== 'string' || secretKey.length === 0) {
      throw new StripeExtractorError('STRIPE_SECRET_KEY is not set', { code: 'EAUTH' })
    }
    const match = /^(?:sk|rk)_(live|test)_/.exec(secretKey)
    if (!match) {
      throw new StripeExtractorError('STRIPE_SECRET_KEY has an unsupported format', { code: 'EAUTH' })
    }
    this.mode = match[1]
    this.#secretKey = secretKey
    this.#fetch = fetchImpl
  }

  #secretKey
  #fetch

  async get(endpoint, params = {}) {
    const url = new URL(`${STRIPE_API}${endpoint}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }

    let response
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#secretKey}` },
        redirect: 'error',
      })
    } catch (error) {
      throw new StripeExtractorError(`Stripe request failed: ${safeMessage(error, this.#secretKey)}`, {
        code: 'ENETWORK',
      })
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new StripeExtractorError(`Stripe returned invalid JSON (HTTP ${response.status})`, {
        code: 'ERESPONSE',
        status: response.status,
      })
    }
    if (!response.ok) {
      const message = body?.error?.message ?? `HTTP ${response.status}`
      throw new StripeExtractorError(safeMessage(String(message), this.#secretKey), {
        code: body?.error?.code ?? 'EAPI',
        status: response.status,
      })
    }
    return body
  }

  async listAll(endpoint) {
    return listAllWith((resource, params) => this.get(resource, params), endpoint)
  }
}

export class StripeCliClient {
  #run

  constructor({ run = runStripeCli } = {}) {
    this.mode = 'live'
    this.#run = run
  }

  async get(endpoint, params = {}) {
    const resource = stripeResourcePath(endpoint)
    const args = ['get', `/v1${resource}`, '--live', '--color', 'off', '--log-level', 'error']
    for (const [key, value] of Object.entries(params)) {
      if (key === 'limit') {
        if (!Number.isInteger(value) || value < 1 || value > PAGE_SIZE) {
          throw new StripeExtractorError('Stripe CLI page limit must be from 1 to 100', { code: 'EPARAM' })
        }
        args.push('--limit', String(value))
      } else if (key === 'starting_after') {
        if (value !== undefined) {
          if (typeof value !== 'string' || !/^[A-Za-z0-9_]+$/.test(value)) {
            throw new StripeExtractorError('Stripe CLI pagination cursor is invalid', { code: 'EPARAM' })
          }
          args.push('--starting-after', value)
        }
      } else {
        throw new StripeExtractorError(`Unsupported Stripe CLI parameter ${key}`, { code: 'EPARAM' })
      }
    }
    const result = await this.#run(args)
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new StripeExtractorError(`Stripe CLI returned an invalid response for ${endpoint}`, {
        code: 'ERESPONSE',
      })
    }
    return result
  }

  async listAll(endpoint) {
    return listAllWith((resource, params) => this.get(resource, params), endpoint)
  }
}

async function listAllWith(get, endpoint) {
  const objects = []
  const ids = new Set()
  let startingAfter

  for (;;) {
    const page = await get(endpoint, { limit: PAGE_SIZE, starting_after: startingAfter })
    if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean') {
      throw new StripeExtractorError(`Stripe returned an invalid list response for ${endpoint}`, {
        code: 'EPAGINATION',
      })
    }
    for (const object of page.data) {
      if (typeof object?.id !== 'string' || ids.has(object.id)) {
        throw new StripeExtractorError(`Stripe returned a missing or repeated object ID for ${endpoint}`, {
          code: 'EPAGINATION',
        })
      }
      ids.add(object.id)
      objects.push(object)
    }
    if (!page.has_more) return objects
    if (page.data.length === 0) {
      throw new StripeExtractorError(`Stripe pagination stalled for ${endpoint}`, { code: 'EPAGINATION' })
    }
    startingAfter = page.data.at(-1).id
  }
}

function stripeResourcePath(endpoint) {
  if (endpoint === '/account') return '/account'
  if (['/products', '/prices', '/payment_links'].includes(endpoint)) return endpoint
  if (/^\/payment_links\/[A-Za-z0-9_]+\/line_items$/.test(endpoint)) return endpoint
  throw new StripeExtractorError(`Unsupported Stripe CLI endpoint ${endpoint}`, { code: 'EPATH' })
}

function runStripeCli(args) {
  if (!args.every((arg) => /^[A-Za-z0-9_./-]+$/.test(arg))) {
    return Promise.reject(new StripeExtractorError('Unsafe Stripe CLI argument rejected', { code: 'EPARAM' }))
  }
  const env = { ...process.env }
  delete env.STRIPE_API_KEY
  delete env.STRIPE_SECRET_KEY
  const command = process.platform === 'win32' ? 'cmd.exe' : 'stripe'
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `stripe.cmd ${args.join(' ')}`]
    : args

  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, {
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().slice(0, 1000)
        const authFailure = /not logged in|login|unauthori[sz]ed|authentication/i.test(detail)
        reject(new StripeExtractorError(
          `Stripe CLI request failed${detail ? `: ${detail}` : ''}`,
          { code: authFailure ? 'EAUTH' : 'ECLI' },
        ))
        return
      }
      const start = stdout.indexOf('{')
      const end = stdout.lastIndexOf('}')
      if (start < 0 || end < start) {
        reject(new StripeExtractorError('Stripe CLI returned no JSON response', { code: 'ERESPONSE' }))
        return
      }
      try {
        resolve(JSON.parse(stdout.slice(start, end + 1)))
      } catch {
        reject(new StripeExtractorError('Stripe CLI returned invalid JSON', { code: 'ERESPONSE' }))
      }
    })
  })
}

export async function extractStripeCatalog({
  client,
  evidenceRoot = path.resolve('evidence', 'stripe'),
  clock = () => new Date(),
} = {}) {
  try {
    client ??= new StripeClient()
  } catch (error) {
    return {
      status: 'BLOCKED',
      authentication: 'BLOCKED',
      mode: 'UNKNOWN',
      errors: [error.message],
      evidencePath: null,
    }
  }

  let account
  try {
    account = await client.get('/account')
  } catch (error) {
    const blocked = isAuthorizationError(error)
    return {
      status: blocked ? 'BLOCKED' : 'PARTIAL',
      authentication: blocked ? 'BLOCKED' : 'UNVERIFIED',
      mode: client.mode.toUpperCase(),
      errors: [error.message],
      evidencePath: null,
    }
  }

  const errors = []
  const warnings = []
  let authorizationBlocked = false
  const [productsResult, pricesResult, paymentLinksResult] = await Promise.all([
    capture(() => client.listAll('/products')),
    capture(() => client.listAll('/prices')),
    capture(() => client.listAll('/payment_links')),
  ])
  const products = productsResult.value ?? []
  const prices = pricesResult.value ?? []
  const paymentLinks = paymentLinksResult.value ?? []
  for (const result of [productsResult, pricesResult, paymentLinksResult]) {
    if (result.error) {
      errors.push(result.error.message)
      authorizationBlocked ||= isAuthorizationError(result.error)
    }
  }

  const linksWithItems = await Promise.all(paymentLinks.map(async (link) => {
    try {
      const lineItems = await client.listAll(`/payment_links/${encodeURIComponent(link.id)}/line_items`)
      return { ...link, line_items: lineItems }
    } catch (error) {
      warnings.push(`Payment Link ${link.id} line items unavailable: ${error.message}`)
      authorizationBlocked ||= isAuthorizationError(error)
      return { ...link, line_items: null }
    }
  }))

  const mode = resolveMode(client.mode, [...products, ...prices, ...paymentLinks])
  const normalizedPrices = prices.map((price) => normalizePrice(price, mode))
  const pricesById = new Map(normalizedPrices.map((price) => [price.stripe_price_id, price]))
  const pricesByProduct = groupBy(normalizedPrices, (price) => price.product_id)
  const normalizedLinks = linksWithItems.map((link) => normalizePaymentLink(link, mode, pricesById))
  const linksByProduct = new Map()
  for (const link of normalizedLinks) {
    for (const item of link.line_items ?? []) {
      const price = pricesById.get(item.stripe_price_id)
      const productId = price?.product_id ?? item.product_id
      if (!productId) continue
      const existing = linksByProduct.get(productId) ?? []
      if (!existing.includes(link.payment_link_id)) existing.push(link.payment_link_id)
      linksByProduct.set(productId, existing)
    }
  }

  const normalizedProducts = products.map((product) => {
    const defaultPriceId = objectId(product.default_price)
    return {
      stripe_product_id: product.id,
      name: product.name ?? '',
      description: product.description ?? null,
      active: product.active === true,
      created: isoTimestamp(product.created),
      images: Array.isArray(product.images) ? product.images : [],
      metadata: product.metadata ?? {},
      default_price: defaultPriceId ? (pricesById.get(defaultPriceId) ?? defaultPriceId) : null,
      prices: pricesByProduct.get(product.id) ?? [],
      payment_links: linksByProduct.get(product.id) ?? [],
      mode,
      evidence_status: 'VERIFIED',
    }
  })

  const normalizedAccount = {
    stripe_account_id: typeof account.id === 'string' ? account.id : null,
    country: account.country ?? null,
    default_currency: account.default_currency ?? null,
    mode,
    authentication: 'VERIFIED',
  }
  const summary = summarize(normalizedProducts, normalizedPrices, normalizedLinks, mode)
  const complete = errors.length === 0 && warnings.length === 0
  const status = authorizationBlocked ? 'BLOCKED' : complete ? 'VERIFIED' : 'PARTIAL'
  const timestamp = clock().toISOString()
  const dirname = timestamp.replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
  const evidencePath = path.join(evidenceRoot, dirname)
  await mkdir(evidencePath, { recursive: true })

  const artifacts = {
    'stripe-account-summary.json': normalizedAccount,
    'products.json': products.map((product) => normalizeProductExport(product, mode)),
    'prices.json': normalizedPrices,
    'payment-links.json': normalizedLinks,
    'catalog-normalized.json': normalizedProducts,
    'catalog-normalized.csv': toCsv(normalizedProducts),
    'catalog-summary.json': summary,
  }
  for (const [filename, data] of Object.entries(artifacts)) {
    await writeFile(path.join(evidencePath, filename), serialize(data), 'utf8')
  }

  const artifactHashes = {}
  for (const filename of Object.keys(artifacts)) {
    artifactHashes[filename] = await sha256(path.join(evidencePath, filename))
  }
  const evidence = {
    extraction_timestamp_utc: timestamp,
    stripe_account_id: normalizedAccount.stripe_account_id,
    mode,
    status: complete ? 'COMPLETED' : status,
    evidence_status: complete ? 'VERIFIED' : status,
    extractor_version: STRIPE_EXTRACTOR_VERSION,
    object_counts: {
      products: products.length,
      prices: prices.length,
      payment_links: paymentLinks.length,
    },
    pagination_complete: complete,
    artifact_sha256: artifactHashes,
    errors,
    warnings,
  }
  await writeFile(path.join(evidencePath, 'extraction-evidence.json'), serialize(evidence), 'utf8')
  const checksumFiles = [
    ...Object.keys(artifacts),
    'extraction-evidence.json',
  ]
  const checksums = []
  for (const filename of checksumFiles) {
    checksums.push(`${await sha256(path.join(evidencePath, filename))}  ${filename}`)
  }
  await writeFile(path.join(evidencePath, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8')

  return {
    status,
    authentication: authorizationBlocked ? 'BLOCKED' : 'VERIFIED',
    mode: mode.toUpperCase(),
    pagination: complete ? 'COMPLETE' : 'PARTIAL',
    evidencePath,
    catalogSha256: await sha256(path.join(evidencePath, 'catalog-normalized.json')),
    summary,
    evidence,
  }
}

export async function verifyStripeEvidence(evidencePath) {
  const evidence = JSON.parse(await readFile(path.join(evidencePath, 'extraction-evidence.json'), 'utf8'))
  const sumsText = await readFile(path.join(evidencePath, 'SHA256SUMS.txt'), 'utf8')
  const expected = new Map()
  for (const line of sumsText.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line)
    if (!match) throw new StripeExtractorError('Invalid SHA256SUMS.txt entry', { code: 'EVIDENCE' })
    expected.set(match[2], match[1])
  }

  const checked = []
  for (const [filename, hash] of expected) {
    const actual = await sha256(path.join(evidencePath, filename))
    if (actual !== hash) {
      return { ok: false, checked, error: `SHA-256 mismatch: ${filename}` }
    }
    checked.push(filename)
  }
  for (const [filename, hash] of Object.entries(evidence.artifact_sha256 ?? {})) {
    if (expected.get(filename) !== hash) {
      return { ok: false, checked, error: `Evidence hash mismatch: ${filename}` }
    }
  }
  for (const filename of ['products.json', 'prices.json', 'payment-links.json', 'catalog-normalized.json']) {
    if (!expected.has(filename)) return { ok: false, checked, error: `Missing checksum: ${filename}` }
  }

  const products = JSON.parse(await readFile(path.join(evidencePath, 'catalog-normalized.json'), 'utf8'))
  const prices = JSON.parse(await readFile(path.join(evidencePath, 'prices.json'), 'utf8'))
  const links = JSON.parse(await readFile(path.join(evidencePath, 'payment-links.json'), 'utf8'))
  const productIds = new Set(products.map((product) => product.stripe_product_id))
  const priceIds = new Set(prices.map((price) => price.stripe_price_id))
  const errors = []
  for (const price of prices) {
    if (!productIds.has(price.product_id)) errors.push(`Price ${price.stripe_price_id} references missing product ${price.product_id}`)
  }
  for (const product of products) {
    if (typeof product.default_price === 'object' && product.default_price !== null
      && !priceIds.has(product.default_price.stripe_price_id)) {
      errors.push(`Product ${product.stripe_product_id} references missing default price`)
    }
    if (typeof product.default_price === 'string' && !priceIds.has(product.default_price)) {
      errors.push(`Product ${product.stripe_product_id} references missing default price ${product.default_price}`)
    }
  }
  for (const link of links) {
    for (const item of link.line_items ?? []) {
      if (item.stripe_price_id && !priceIds.has(item.stripe_price_id)) {
        errors.push(`Payment Link ${link.payment_link_id} references missing price ${item.stripe_price_id}`)
      }
      if (item.product_id && !productIds.has(item.product_id)) {
        errors.push(`Payment Link ${link.payment_link_id} references missing product ${item.product_id}`)
      }
    }
  }
  return { ok: errors.length === 0, checked, errors }
}

export async function findLatestEvidence(evidenceRoot) {
  const entries = await readdir(evidenceRoot, { withFileTypes: true })
  const snapshots = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  if (snapshots.length === 0) throw new StripeExtractorError('No Stripe evidence snapshots found', { code: 'ENOENT' })
  return path.join(evidenceRoot, snapshots.at(-1))
}

function normalizePrice(price, mode) {
  const recurring = price.recurring
    ? {
        interval: price.recurring.interval ?? null,
        interval_count: price.recurring.interval_count ?? null,
        usage_type: price.recurring.usage_type ?? null,
        trial_period_days: price.recurring.trial_period_days ?? null,
      }
    : null
  return {
    stripe_price_id: price.id,
    product_id: objectId(price.product),
    active: price.active === true,
    currency: (price.currency ?? '').toLowerCase(),
    unit_amount: price.unit_amount ?? null,
    unit_amount_decimal: price.unit_amount_decimal ?? null,
    type: price.type === 'recurring' || recurring ? 'recurring' : 'one_time',
    recurring,
    lookup_key: price.lookup_key ?? null,
    tax_behavior: price.tax_behavior ?? null,
    metadata: price.metadata ?? {},
    created: isoTimestamp(price.created),
    mode: price.livemode === undefined ? mode : (price.livemode ? 'live' : 'test'),
  }
}

function normalizeProductExport(product, mode) {
  return {
    id: product.id,
    name: product.name ?? '',
    description: product.description ?? null,
    active: product.active === true,
    created: isoTimestamp(product.created),
    images: Array.isArray(product.images) ? product.images : [],
    metadata: product.metadata ?? {},
    default_price: objectId(product.default_price),
    livemode: product.livemode ?? (mode === 'live'),
  }
}

function normalizePaymentLink(link, mode, pricesById) {
  return {
    payment_link_id: link.id,
    active: link.active === true,
    url: link.url ?? null,
    created: isoTimestamp(link.created),
    metadata: link.metadata ?? {},
    line_items: Array.isArray(link.line_items)
      ? link.line_items.map((item) => ({
          stripe_price_id: objectId(item.price),
          product_id: objectId(item.price?.product ?? item.product)
            ?? pricesById.get(objectId(item.price))?.product_id
            ?? null,
          quantity: item.quantity ?? null,
        }))
      : null,
    mode: link.livemode === undefined ? mode : (link.livemode ? 'live' : 'test'),
  }
}

function summarize(products, prices, paymentLinks, mode) {
  return {
    total_products: products.length,
    active_products: products.filter((product) => product.active).length,
    archived_products: products.filter((product) => !product.active).length,
    total_prices: prices.length,
    active_prices: prices.filter((price) => price.active).length,
    one_time_prices: prices.filter((price) => price.type === 'one_time').length,
    recurring_prices: prices.filter((price) => price.type === 'recurring').length,
    currencies: [...new Set(prices.map((price) => price.currency).filter(Boolean))].sort(),
    payment_links: paymentLinks.length,
    mode: mode.toUpperCase(),
  }
}

function toCsv(products) {
  const columns = [
    'stripe_product_id', 'name', 'description', 'active', 'created', 'images',
    'metadata', 'default_price', 'prices', 'payment_links', 'mode', 'evidence_status',
  ]
  const rows = products.map((product) => columns.map((column) => csvValue(product[column])).join(','))
  return `${[columns.join(','), ...rows].join('\n')}\n`
}

function csvValue(value) {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function isoTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function objectId(value) {
  if (typeof value === 'string') return value
  return typeof value?.id === 'string' ? value.id : null
}

function groupBy(values, keyOf) {
  const groups = new Map()
  for (const value of values) {
    const key = keyOf(value)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  return groups
}

function resolveMode(defaultMode, objects) {
  const modes = new Set(objects
    .filter((object) => typeof object.livemode === 'boolean')
    .map((object) => object.livemode ? 'live' : 'test'))
  if (modes.size > 1) return 'mixed'
  return modes.values().next().value ?? defaultMode
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function sha256(filename) {
  const contents = await readFile(filename)
  return createHash('sha256').update(contents).digest('hex')
}

async function capture(operation) {
  try {
    return { value: await operation(), error: null }
  } catch (error) {
    return { value: null, error }
  }
}

function isAuthorizationError(error) {
  return error?.code === 'EAUTH' || error?.status === 401 || error?.status === 403
}

function safeMessage(message, secret) {
  return message.split(secret).join(maskSecret(secret))
}

function maskSecret(secret) {
  return `${secret.slice(0, 8)}...${secret.slice(-4)}`
}
