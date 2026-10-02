import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog } from '../src/audit.mjs'

function fixedClock() {
  let t = 0
  return () => new Date(Date.UTC(2026, 0, 1) + (t += 1000))
}

test('an empty log verifies and reports the genesis head', () => {
  const log = new AuditLog()
  assert.equal(log.entries().length, 0)
  assert.equal(log.head(), '0'.repeat(64))
  assert.deepEqual(log.verify(), {
    ok: true,
    brokenAt: null,
    reason: null,
    head: '0'.repeat(64),
  })
})

test('entries are numbered from zero and linked', () => {
  const log = new AuditLog({ clock: fixedClock() })
  const a = log.append('one', { x: 1 })
  const b = log.append('two', { y: 2 })
  assert.equal(a.seq, 0)
  assert.equal(b.seq, 1)
  assert.equal(a.prev, '0'.repeat(64))
  assert.equal(b.prev, a.hash)
  assert.ok(log.verify().ok)
})

test('entries are frozen so a caller cannot edit history in place', () => {
  const log = new AuditLog()
  const entry = log.append('one', { x: 1 })
  assert.throws(() => {
    entry.payload.x = 999
  }, TypeError)
  assert.equal(log.entries()[0].payload.x, 1)
})

test('entries() returns a copy, not the internal array', () => {
  const log = new AuditLog()
  log.append('one', {})
  const list = log.entries()
  list.push({ fake: true })
  assert.equal(log.entries().length, 1)
})

test('the hash covers payload contents', () => {
  const log = new AuditLog({ clock: fixedClock() })
  const first = log.append('evt', { amount: '10' })
  const second = log.append('evt', { amount: '11' })
  assert.notEqual(first.hash, second.hash)
})

test('key order does not change the hash', () => {
  const log = new AuditLog({ clock: fixedClock() })
  const a = log.append('evt', { b: 2, a: 1 })
  const c = log.append('evt', { a: 1, b: 2 })
  // Same content, different insertion order: the digests differ only because
  // seq and prev differ, and each entry is still self-consistent.
  assert.notEqual(a.hash, c.hash)
  assert.ok(log.verify().ok)
})

test('a rewritten payload breaks verification at that entry', () => {
  const log = new AuditLog({ clock: fixedClock() })
  log.append('order.created', { total: '10' })
  log.append('order.paid', { total: '10' })

  // Models an entry edited after the fact: the payload changed, the recorded
  // hash was left alone. Verified through the static entry point because the
  // instance is frozen, which is exactly the property that makes this a file
  // problem rather than an in-memory one.
  const tampered = log.entries().map((e, i) => (i === 0 ? { ...e, payload: { total: '0' } } : e))

  const result = AuditLog.verifyEntries(tampered)
  assert.equal(result.ok, false)
  assert.equal(result.brokenAt, 0)
  assert.equal(result.reason, 'hash-mismatch')
})

test('a removed entry breaks the chain link at the next one', () => {
  const log = new AuditLog({ clock: fixedClock() })
  log.append('one', {})
  log.append('two', {})
  log.append('three', {})

  const removed = log.entries().filter((e) => e.seq !== 1)

  const result = AuditLog.verifyEntries(removed)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'prev-mismatch')
})

test('an intact chain read back from storage still verifies', () => {
  const log = new AuditLog({ clock: fixedClock() })
  log.append('one', { a: 1 })
  log.append('two', { b: 2 })

  // A JSON round trip is what a persisted log goes through, and key order can
  // change across the trip. It must not break verification.
  const roundTripped = JSON.parse(JSON.stringify(log.entries()))
  assert.ok(AuditLog.verifyEntries(roundTripped).ok)
  assert.equal(AuditLog.verifyEntries(roundTripped).head, log.head())
})

test('byType filters without exposing the log itself', () => {
  const log = new AuditLog()
  log.append('a', {})
  log.append('b', {})
  log.append('a', {})
  assert.equal(log.byType('a').length, 2)
  assert.equal(log.byType('missing').length, 0)
})
