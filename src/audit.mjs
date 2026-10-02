// Append-only event log with a hash chain.
//
// Every state change in this package goes through here. The chain exists so a
// later reader can tell whether a record was added or rewritten after the fact:
// each entry commits to the hash of the one before it, so removing or editing
// any earlier entry breaks verification from that point on.
//
// This is tamper *evidence*, not tamper resistance. The file is writable by
// anyone with the same permissions, and an attacker who can rewrite the whole
// file can rewrite the chain too. Proving that requires anchoring the head hash
// somewhere they cannot reach, which is not implemented here. See STATUS.md.

import { createHash, randomUUID } from 'node:crypto'

const GENESIS = '0'.repeat(64)

export class AuditLog {
  #entries = []
  #seq = 0

  // `clock` is injected so a test can produce a deterministic chain. Timestamps
  // are part of the hash, so a real log cannot be replayed into a stable
  // fixture without one.
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock
  }

  append(type, payload = {}) {
    const previous = this.#entries.at(-1)
    const entry = {
      seq: this.#seq,
      id: randomUUID(),
      at: this.clock().toISOString(),
      type,
      payload,
      prev: previous ? previous.hash : GENESIS,
    }
    entry.hash = digest(entry)
    this.#seq += 1
    // Deep-frozen: `Object.freeze` on the entry alone still leaves
    // `entry.payload.amount = '0'` writable, which would let a caller rewrite a
    // past event's contents while leaving its recorded hash intact.
    deepFreeze(entry)
    this.#entries.push(entry)
    return entry
  }

  entries() {
    return this.#entries.slice()
  }

  head() {
    return this.#entries.at(-1)?.hash ?? GENESIS
  }

  // Returns the first entry whose recorded hash does not match its contents, or
  // reports an intact chain.
  verify() {
    return AuditLog.verifyEntries(this.#entries)
  }

  // Verifies an array of entries. Static because the case that matters is a log
  // read back from storage after someone had access to the file, which is not
  // an instance of this class. Passing the array in is what makes that testable
  // at all, and it is the only honest way to check a file someone can edit.
  static verifyEntries(entries) {
    let expectedPrev = GENESIS
    for (const entry of entries) {
      const { hash, ...rest } = entry
      if (rest.prev !== expectedPrev) {
        return { ok: false, brokenAt: entry.seq, reason: 'prev-mismatch' }
      }
      if (digest(rest) !== hash) {
        return { ok: false, brokenAt: entry.seq, reason: 'hash-mismatch' }
      }
      expectedPrev = hash
    }
    return { ok: true, brokenAt: null, reason: null, head: expectedPrev }
  }

  // Every event of one type, newest last. Used by reconciliation to rebuild
  // derived state rather than trusting a stored total.
  byType(type) {
    return this.#entries.filter((e) => e.type === type)
  }
}

function digest({ seq, id, at, type, payload, prev }) {
  // Sorted keys, because JSON key order is not guaranteed stable across
  // serialisers and an unstable hash makes the whole chain unverifiable.
  return createHash('sha256')
    .update(JSON.stringify({ seq, id, at, type, payload: sortKeys(payload), prev }))
    .digest('hex')
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  // A frozen object can still hold a mutable child, so the whole graph is
  // walked rather than just the top level.
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
  return out
}
