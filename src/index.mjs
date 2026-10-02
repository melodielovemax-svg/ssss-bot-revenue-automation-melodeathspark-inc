// Public API. The surface is what the README documents and nothing more.

export { AuditLog } from './audit.mjs'
export { Catalog, CatalogError, describe } from './catalog.mjs'
export {
  createOrder,
  markPaid,
  issueLicences,
  refundOrder,
  assignSeat,
  replay,
  OrderError,
  ORDER_OPEN,
  ORDER_PAID,
  ORDER_FULFILLED,
  ORDER_REFUNDED,
  ORDER_CANCELLED,
  LICENCE_ACTIVE,
  LICENCE_EXPIRED,
  LICENCE_REVOKED,
} from './orders.mjs'
export { Loyalty, LoyaltyError, TIERS, UNSUPPORTED } from './loyalty.mjs'
export { money, toMinor, format, add, zero, isZero, exponentOf, MoneyError } from './money.mjs'
export {
  StripeClient,
  StripeCliClient,
  StripeExtractorError,
  STRIPE_EXTRACTOR_VERSION,
  extractStripeCatalog,
  findLatestEvidence,
  verifyStripeEvidence,
} from './stripe-extractor.mjs'
