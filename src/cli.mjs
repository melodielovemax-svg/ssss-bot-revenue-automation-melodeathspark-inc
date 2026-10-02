#!/usr/bin/env node

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  StripeClient,
  StripeCliClient,
  StripeExtractorError,
  extractStripeCatalog,
  findLatestEvidence,
  verifyStripeEvidence,
} from './stripe-extractor.mjs'

const [area, command, ...args] = process.argv.slice(2)
const evidenceRoot = path.resolve('evidence', 'stripe')

async function main() {
  if (area !== 'stripe' || !['doctor', 'account', 'extract', 'products', 'prices', 'payment-links', 'summary', 'verify'].includes(command)) {
    throw new StripeExtractorError(
      'Usage: melodie stripe <doctor|account|extract|products|prices|payment-links|summary|verify> [evidence-path]',
      { code: 'EUSAGE' },
    )
  }

  if (command === 'summary') {
    const snapshot = await findLatestEvidence(evidenceRoot)
    process.stdout.write(await readSummary(snapshot))
    return
  }
  if (command === 'verify') {
    const snapshot = args[0] ? path.resolve(args[0]) : await findLatestEvidence(evidenceRoot)
    const result = await verifyStripeEvidence(snapshot)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
    return
  }

  const client = createStripeClient()
  if (command === 'doctor' || command === 'account') {
    const account = await client.get('/account')
    const result = {
      authentication: 'VERIFIED',
      stripe_account_id: account.id ?? null,
      country: account.country ?? null,
      default_currency: account.default_currency ?? null,
      mode: client.mode.toUpperCase(),
      stripe_mutations: 'DISABLED',
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === 'extract') {
    const result = await extractStripeCatalog({ client, evidenceRoot })
    printExtractionReport(result)
    if (result.status !== 'VERIFIED') process.exitCode = 1
    return
  }

  const endpoint = {
    products: '/products',
    prices: '/prices',
    'payment-links': '/payment_links',
  }[command]
  const objects = await client.listAll(endpoint)
  process.stdout.write(`${JSON.stringify(objects, null, 2)}\n`)
}

function createStripeClient() {
  return process.env.STRIPE_SECRET_KEY
    ? new StripeClient()
    : new StripeCliClient()
}

async function readSummary(snapshot) {
  return readFile(path.join(snapshot, 'catalog-summary.json'), 'utf8')
}

function printExtractionReport(result) {
  const summary = result.summary ?? {}
  process.stdout.write([
    `Authentication:       ${result.authentication}`,
    `Mode:                 ${result.mode}`,
    `Products:             ${summary.total_products ?? 'UNAVAILABLE'}`,
    `Prices:               ${summary.total_prices ?? 'UNAVAILABLE'}`,
    `Payment Links:        ${summary.payment_links ?? 'UNAVAILABLE'}`,
    `Pagination:           ${result.pagination ?? 'PARTIAL'}`,
    `Catalog Evidence:     ${result.evidencePath ?? 'UNAVAILABLE'}`,
    `Catalog SHA-256:      ${result.catalogSha256 ?? 'UNAVAILABLE'}`,
    'Stripe mutations:     DISABLED',
    'Payments created:     0',
    'Refunds created:      0',
    `STATUS: ${result.status}`,
    ...(result.errors ?? []).map((error) => `ERROR: ${error}`),
  ].join('\n') + '\n')
}

main().catch((error) => {
  const blocked = error.code === 'EAUTH' || error.status === 401 || error.status === 403
  if (command === 'extract') {
    printExtractionReport({
      authentication: blocked ? 'BLOCKED' : 'UNVERIFIED',
      mode: 'UNKNOWN',
      status: blocked ? 'BLOCKED' : 'PARTIAL',
      pagination: 'PARTIAL',
      errors: [error.message],
    })
  } else {
    process.stderr.write(`${blocked ? 'BLOCKED' : 'ERROR'}: ${error.message}\n`)
  }
  process.exitCode = 1
})
