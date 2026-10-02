import test from 'node:test'
import assert from 'node:assert/strict'
import { Catalog, CatalogError, describe } from '../src/catalog.mjs'

function valid(over = {}) {
  return {
    sku: 'toolkit-pro',
    title: 'Toolkit Pro',
    kind: 'digital',
    price: { amount: '49.00', asset: 'USD' },
    licence: { tier: 'team', term: 'perpetual', seats: 5 },
    ...over,
  }
}

test('accepts a valid product and parses its price', () => {
  const catalog = new Catalog()
  const product = catalog.add(valid())
  assert.equal(product.price.minor, 4900n)
  assert.equal(product.price.asset, 'USD')
  assert.equal(product.published, true)
  assert.ok(catalog.has('toolkit-pro'))
})

test('parses a six-decimal crypto price exactly', () => {
  const catalog = new Catalog()
  const product = catalog.add(valid({ price: { amount: '7.111384', asset: 'USDT' } }))
  assert.equal(product.price.minor, 7111384n)
})

test('rejects a malformed sku', () => {
  const catalog = new Catalog()
  for (const sku of ['', 'A', 'Toolkit', 'has space', '-leading', 'x'.repeat(65)]) {
    assert.throws(() => catalog.add(valid({ sku })), CatalogError, `accepted sku ${sku}`)
  }
})

test('rejects a missing title and an unknown kind', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.add(valid({ title: '   ' })), CatalogError)
  assert.throws(() => catalog.add(valid({ kind: 'consulting' })), CatalogError)
})

test('rejects a price with too many decimals for the asset', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.add(valid({ price: { amount: '49.001', asset: 'USD' } })), /allows 2/)
  assert.throws(() => catalog.add(valid({ price: { amount: '1.0000001', asset: 'USDT' } })), /allows 6/)
})

test('rejects an unknown asset', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.add(valid({ price: { amount: '1', asset: 'DOGE' } })), /unknown asset/)
})

test('rejects licence terms that cannot be evaluated later', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.add(valid({ licence: undefined })), /needs licence terms/)
  assert.throws(() => catalog.add(valid({ licence: { tier: 'platinum' } })), /unknown licence tier/)
  assert.throws(() => catalog.add(valid({ licence: { tier: 'team', term: 'annual' } })), /needs termDays/)
  assert.throws(() => catalog.add(valid({ licence: { tier: 'team', seats: 0 } })), /positive integer/)
  assert.throws(() => catalog.add(valid({ licence: { tier: 'team', seats: 1.5 } })), CatalogError)
})

test('accepts a non-perpetual licence that states termDays', () => {
  const catalog = new Catalog()
  const product = catalog.add(valid({ licence: { tier: 'personal', term: 'annual', termDays: 365 } }))
  assert.equal(product.licence.term, 'annual')
  assert.equal(product.licence.termDays, 365)
})

test('requires https for a delivery url', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.add(valid({ delivery: { retrievalUrl: 'http://cdn.example/f.zip' } })), /https/)
  const ok = catalog.add(valid({ delivery: { retrievalUrl: 'https://cdn.example/f.zip' } }))
  assert.equal(ok.delivery.retrievalUrl, 'https://cdn.example/f.zip')
})

test('rejects a duplicate sku and leaves the catalogue untouched', () => {
  const catalog = new Catalog()
  catalog.add(valid())
  assert.throws(() => catalog.add(valid()), /duplicate sku/)
  assert.equal(catalog.list().length, 1)
})

test('addAll is all-or-nothing so a bad definition cannot half-apply', () => {
  const catalog = new Catalog()
  assert.throws(
    () => catalog.addAll([valid(), valid({ sku: 'other', price: { amount: 'x', asset: 'USD' } })]),
    CatalogError,
  )
  assert.equal(catalog.list().length, 0, 'a rejected batch left a partial catalogue')
})

test('get throws on an unknown sku rather than returning undefined', () => {
  const catalog = new Catalog()
  assert.throws(() => catalog.get('missing'), /unknown sku/)
})

test('list filters unpublished products and sorts by sku', () => {
  const catalog = new Catalog()
  catalog.addAll([
    valid({ sku: 'b-item' }),
    valid({ sku: 'a-item', published: false }),
    valid({ sku: 'c-item', kind: 'service', licence: { tier: 'enterprise', term: 'perpetual' } }),
  ])
  assert.deepEqual(catalog.list().map((p) => p.sku), ['b-item', 'c-item'])
  assert.deepEqual(catalog.list({ publishedOnly: false }).map((p) => p.sku), ['a-item', 'b-item', 'c-item'])
  assert.deepEqual(catalog.list({ kind: 'service' }).map((p) => p.sku), ['c-item'])
})

test('products are frozen so a price cannot be edited after listing', () => {
  const catalog = new Catalog()
  const product = catalog.add(valid())
  assert.throws(() => {
    product.price.minor = 0n
  }, TypeError)
  assert.throws(() => {
    product.licence.tier = 'enterprise'
  }, TypeError)
  assert.equal(catalog.get('toolkit-pro').price.minor, 4900n)
})

test('describe states the amount, the tier and the term', () => {
  const catalog = new Catalog()
  const text = describe(catalog.add(valid()))
  assert.match(text, /49\.00 USD/)
  assert.match(text, /team, perpetual/)
})
