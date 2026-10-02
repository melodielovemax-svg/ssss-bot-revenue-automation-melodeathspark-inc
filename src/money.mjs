// Money is held in integer minor units and only ever moves through this module.
//
// Floating point is not used anywhere in this package. A float cannot represent
// 0.1 exactly, so a float total accumulates error across a catalogue of products
// and the amount the customer authorised stops matching the amount charged.
// Every amount here is a BigInt of minor units, and the currency's exponent is
// recorded alongside it, because "7.111384" is 6 decimals in USDT and would be
// a rounding error in USD.

export class MoneyError extends Error {
  constructor(message, code = 'EMONEY') {
    super(message)
    this.name = 'MoneyError'
    this.code = code
  }
}

// Decimal places per supported asset. Adding an asset means adding its exponent
// here and nowhere else.
const EXPONENTS = new Map([
  ['USD', 2],
  ['EUR', 2],
  ['USDT', 6],
  ['USDC', 6],
])

const RE = /^(\d+)(?:\.(\d*))?$/

// Parses a decimal string into minor units. Strings only, by design: accepting
// a number here would mean the caller's value was already rounded before this
// function saw it, which is exactly the error this module exists to prevent.
export function toMinor(amount, asset) {
  const exponent = EXPONENTS.get(asset)
  if (exponent === undefined) {
    throw new MoneyError(`unknown asset ${asset}`, 'EASSET')
  }
  if (typeof amount !== 'string') {
    throw new MoneyError(`amount must be a string, got ${typeof amount}`, 'EAMOUNT')
  }

  const match = RE.exec(amount.trim())
  if (!match) {
    throw new MoneyError(`amount ${JSON.stringify(amount)} is not a decimal string`, 'EAMOUNT')
  }

  const [, whole, fraction = ''] = match
  if (fraction.length > exponent) {
    throw new MoneyError(
      `${amount} ${asset} has ${fraction.length} decimals, the asset allows ${exponent}`,
      'EDECIMALS',
    )
  }

  const digits = `${whole}${fraction.padEnd(exponent, '0')}`
  return BigInt(digits === '' ? '0' : digits)
}

// Renders minor units back to a decimal string. `2n` in USD is "0.02"; the same
// value in USDT is "0.000002", which is why the asset has to come along.
export function format(minor, asset) {
  const exponent = EXPONENTS.get(asset)
  if (exponent === undefined) {
    throw new MoneyError(`unknown asset ${asset}`, 'EASSET')
  }
  if (typeof minor !== 'bigint' || minor < 0n) {
    throw new MoneyError(`expected non-negative bigint minor units, got ${minor}`, 'EMINOR')
  }
  const text = minor.toString().padStart(exponent + 1, '0')
  if (exponent === 0) return text
  return `${text.slice(0, -exponent)}.${text.slice(-exponent)}`
}

export function exponentOf(asset) {
  const exponent = EXPONENTS.get(asset)
  if (exponent === undefined) {
    throw new MoneyError(`unknown asset ${asset}`, 'EASSET')
  }
  return exponent
}

// Adds amounts that must share an asset. Refusing to add across assets is the
// point: there is no honest conversion without a rate and a timestamp, and a
// store that invents one silently misprices its own catalogue.
export function add(a, b) {
  if (a.asset !== b.asset) {
    throw new MoneyError(`cannot add ${a.asset} to ${b.asset}`, 'EASSET')
  }
  return { asset: a.asset, minor: a.minor + b.minor }
}

export function money(amount, asset) {
  return { asset, minor: toMinor(amount, asset) }
}

export function zero(asset) {
  return { asset, minor: 0n }
}

export function isZero(m) {
  return m.minor === 0n
}

export function formatAll(list) {
  return list.map((m) => `${format(m.minor, m.asset)} ${m.asset}`).join(' + ')
}
