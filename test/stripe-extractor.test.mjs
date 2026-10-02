import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  StripeClient,
  StripeCliClient,
  extractStripeCatalog,
  verifyStripeEvidence,
} from '../src/stripe-extractor.mjs'

const secretKey = 'sk_test_0123456789abcdef'

function stripeFetch({ failPrices = false, unauthorized = false } = {}) {
  const requests = []
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    requests.push({ url, init })
    if (unauthorized) {
      return response({ error: { message: `Invalid key ${secretKey}` } }, 401)
    }
    const cursor = url.searchParams.get('starting_after')
    switch (url.pathname) {
      case '/v1/account':
        return response({ id: 'acct_demo', country: 'CA', default_currency: 'cad' })
      case '/v1/products':
        return cursor
          ? response({ data: [product('prod_2', false)], has_more: false })
          : response({ data: [product('prod_1', true)], has_more: true })
      case '/v1/prices':
        if (failPrices) return response({ error: { message: 'Temporary Stripe failure' } }, 500)
        return response({
          data: [price('price_1', 'prod_1'), price('price_2', 'prod_2', true)],
          has_more: false,
        })
      case '/v1/payment_links':
        return response({
          data: [{
            id: 'plink_1',
            active: true,
            url: 'https://buy.stripe.com/example',
            created: 1700000000,
            livemode: false,
            metadata: { offer: 'starter' },
          }],
          has_more: false,
        })
      case '/v1/payment_links/plink_1/line_items':
        return response({
          data: [{ id: 'li_1', price: { id: 'price_1', product: 'prod_1' }, quantity: 1 }],
          has_more: false,
        })
      default:
        return response({ error: { message: `Unexpected endpoint ${url.pathname}` } }, 404)
    }
  }
  return { fetchImpl, requests }
}

function product(id, active) {
  return {
    id,
    name: `Product ${id}`,
    description: 'Catalog item',
    active,
    created: 1700000000,
    images: ['https://example.test/image.png'],
    metadata: { group: 'catalog' },
    default_price: id === 'prod_1' ? 'price_1' : null,
    livemode: false,
  }
}

function price(id, productId, recurring = false) {
  return {
    id,
    product: productId,
    active: true,
    currency: 'usd',
    unit_amount: recurring ? null : 1200,
    unit_amount_decimal: recurring ? '12.00' : null,
    type: recurring ? 'recurring' : 'one_time',
    recurring: recurring ? { interval: 'month', interval_count: 1 } : null,
    lookup_key: id,
    tax_behavior: 'exclusive',
    metadata: { source: 'test-fixture' },
    created: 1700000000,
    livemode: false,
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-stripe-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('extracts all pages, normalizes relationships, writes evidence, and makes GET requests only', async (t) => {
  const root = await tempRoot(t)
  const { fetchImpl, requests } = stripeFetch()
  const client = new StripeClient({ secretKey, fetchImpl })
  const result = await extractStripeCatalog({
    client,
    evidenceRoot: root,
    clock: () => new Date('2026-10-01T12:34:56.789Z'),
  })

  assert.equal(result.status, 'VERIFIED')
  assert.equal(result.pagination, 'COMPLETE')
  assert.equal(result.summary.total_products, 2)
  assert.equal(result.summary.archived_products, 1)
  assert.equal(result.summary.recurring_prices, 1)
  assert.equal(result.summary.payment_links, 1)
  assert.ok(requests.every(({ init }) => init.method === 'GET'))
  assert.ok(requests.every(({ init }) => init.headers.Authorization === `Bearer ${secretKey}`))
  const productRequest = requests.find(({ url }) => url.pathname === '/v1/products')
  assert.equal(productRequest.url.searchParams.get('limit'), '100')
  assert.equal(requests.some(({ url }) => url.searchParams.get('starting_after') === 'prod_1'), true)

  const normalized = JSON.parse(await readFile(path.join(result.evidencePath, 'catalog-normalized.json'), 'utf8'))
  assert.deepEqual(normalized[0].payment_links, ['plink_1'])
  assert.equal(normalized[0].default_price.stripe_price_id, 'price_1')
  assert.equal(normalized[0].evidence_status, 'VERIFIED')
  assert.equal((await verifyStripeEvidence(result.evidencePath)).ok, true)
})

test('marks an extraction partial when an endpoint is unauthorized and never invents missing data', async (t) => {
  const root = await tempRoot(t)
  const { fetchImpl } = stripeFetch({ failPrices: true })
  const result = await extractStripeCatalog({
    client: new StripeClient({ secretKey, fetchImpl }),
    evidenceRoot: root,
  })

  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.pagination, 'PARTIAL')
  assert.equal(result.summary.total_prices, 0)
  assert.equal(result.evidence.pagination_complete, false)
  assert.match(result.evidence.errors[0], /Temporary Stripe failure/)
})

test('blocks authentication failures and masks the secret in diagnostics', async () => {
  const { fetchImpl } = stripeFetch({ unauthorized: true })
  const result = await extractStripeCatalog({
    client: new StripeClient({ secretKey, fetchImpl }),
  })

  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.authentication, 'BLOCKED')
  assert.doesNotMatch(result.errors.join(' '), new RegExp(secretKey))
  assert.match(result.errors.join(' '), /sk_test_...cdef/)
  assert.equal(result.evidencePath, null)
})

test('verify detects modified export files', async (t) => {
  const root = await tempRoot(t)
  const { fetchImpl } = stripeFetch()
  const result = await extractStripeCatalog({
    client: new StripeClient({ secretKey, fetchImpl }),
    evidenceRoot: root,
  })
  await import('node:fs/promises').then(({ appendFile }) =>
    appendFile(path.join(result.evidencePath, 'prices.json'), ' '),
  )

  const verification = await verifyStripeEvidence(result.evidencePath)
  assert.equal(verification.ok, false)
  assert.match(verification.error, /SHA-256 mismatch: prices.json/)
})

test('Stripe CLI client uses only live GET requests and follows all pages', async () => {
  const requests = []
  const client = new StripeCliClient({
    run: async (args) => {
      requests.push(args)
      const cursor = args.indexOf('--starting-after')
      return cursor < 0
        ? { data: [{ id: 'prod_first' }], has_more: true }
        : { data: [{ id: 'prod_second' }], has_more: false }
    },
  })

  assert.deepEqual(await client.listAll('/products'), [{ id: 'prod_first' }, { id: 'prod_second' }])
  assert.ok(requests.every((args) => args[0] === 'get' && args.includes('--live')))
  assert.ok(requests.every((args) => args.includes('--limit') && args.includes('100')))
  assert.equal(requests[1].at(-1), 'prod_first')
})

test('Stripe CLI client rejects non-read-only paths and invalid pagination values', async () => {
  const client = new StripeCliClient({ run: async () => ({}) })

  await assert.rejects(() => client.get('/charges'), /Unsupported Stripe CLI endpoint/)
  await assert.rejects(
    () => client.get('/products', { limit: 101 }),
    /page limit must be from 1 to 100/,
  )
  await assert.rejects(
    () => client.get('/products', { starting_after: 'prod_1; stripe delete' }),
    /pagination cursor is invalid/,
  )
})
