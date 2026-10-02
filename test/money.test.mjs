import test from 'node:test'
import assert from 'node:assert/strict'
import { money, toMinor, format, add, zero, MoneyError } from '../src/money.mjs'

test('parses decimal strings into integer minor units', () => {
  assert.equal(toMinor('7.111384', 'USDT'), 7111384n)
  assert.equal(toMinor('0.02', 'USD'), 2n)
  assert.equal(toMinor('10', 'USD'), 1000n)
  assert.equal(toMinor('0', 'USDT'), 0n)
})

test('rejects a number so the caller cannot pre-round the value', () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point. Accepting numbers here would
  // mean the error happened before this function could see it.
  assert.throws(() => toMinor(0.1, 'USD'), MoneyError)
  assert.throws(() => toMinor(100, 'USD'), MoneyError)
})

test('rejects more decimals than the asset has', () => {
  assert.throws(() => toMinor('7.1113841', 'USDT'), /USDT.*allows 6/s)
  assert.throws(() => toMinor('1.001', 'USD'), /allows 2/s)
})

test('rejects non-decimal and negative input', () => {
  assert.throws(() => toMinor('abc', 'USD'), MoneyError)
  assert.throws(() => toMinor('-1', 'USD'), MoneyError)
  assert.throws(() => toMinor('1e3', 'USD'), MoneyError)
  assert.throws(() => toMinor('1,000', 'USD'), MoneyError)
  assert.throws(() => toMinor('', 'USD'), MoneyError)
})

test('rejects an unknown asset rather than assuming a default', () => {
  assert.throws(() => toMinor('1', 'DOGE'), /unknown asset/s)
  assert.throws(() => format(1n, 'DOGE'), /unknown asset/s)
})

test('formats using the asset exponent, not a fixed width', () => {
  // Output is canonical: always the asset's full decimal width, so a receipt
  // never shows "10" for USD and "10.000000" for USDT depending on how the
  // amount was entered.
  assert.equal(format(2n, 'USD'), '0.02')
  assert.equal(format(1000n, 'USD'), '10.00')
  assert.equal(format(100000n, 'USD'), '1000.00')
  assert.equal(format(2n, 'USDT'), '0.000002')
  assert.equal(format(7111384n, 'USDT'), '7.111384')
  assert.equal(format(0n, 'USDT'), '0.000000')
  assert.equal(format(0n, 'USD'), '0.00')
})

test('round trips through parse and format', () => {
  const cases = [
    ['7.111384', 'USDT', '7.111384'],
    ['0.000001', 'USDT', '0.000001'],
    ['10', 'USD', '10.00'],
    ['0.02', 'USD', '0.02'],
    ['1234.56', 'USD', '1234.56'],
  ]
  for (const [input, asset, expected] of cases) {
    assert.equal(format(toMinor(input, asset), asset), expected, `${input} ${asset}`)
  }
})

test('zero needs no exponent knowledge to construct', () => {
  assert.deepEqual(zero('USDT'), { asset: 'USDT', minor: 0n })
})

test('addition refuses to cross assets instead of guessing a rate', () => {
  const usd = money('10', 'USD')
  const usdt = money('10', 'USDT')
  assert.throws(() => add(usd, usdt), /cannot add/s)
  assert.deepEqual(add(usd, money('2.50', 'USD')), { asset: 'USD', minor: 1250n })
})

test('format rejects a negative or non-bigint amount', () => {
  assert.throws(() => format(-1n, 'USD'), MoneyError)
  assert.throws(() => format(100, 'USD'), MoneyError)
})
