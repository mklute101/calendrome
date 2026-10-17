// Shared helpers for the sandbox seed scripts. The seeders write raw
// SQL on purpose (they run without a build), so they cannot import the
// compiled core; this is the one copy of what they share.

/**
 * The current moment in calendrome's canonical stored form, following
 * the server clock convention (src/clock.ts, #149): CALENDROME_NOW is a
 * fixed ISO timestamp or a -3d/+2h/-90m offset. Never SQL-side
 * datetime('now').
 */
export function stampNow() {
  const override = process.env.CALENDROME_NOW;
  let ms = Date.now();
  if (override) {
    const offset = /^([+-])(\d+)([mhd])$/.exec(override);
    if (offset) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[offset[3]];
      ms += (offset[1] === '-' ? -1 : 1) * Number(offset[2]) * unit;
    } else {
      ms = Date.parse(override);
      if (Number.isNaN(ms)) {
        throw new Error(`CALENDROME_NOW is not an ISO timestamp or offset: ${override}`);
      }
    }
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Delete every assignments row (standing and per-week) and Recent Moves
 * entry touching the given envelopes, so a reseed never inherits a
 * stale week's override or pull.
 */
export function wipeEnvelopes(db, type, ids) {
  if (ids.length === 0) return;
  const idPh = ids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM assignments WHERE envelope_type = ? AND envelope_id IN (${idPh})`,
  ).run(type, ...ids);
  db.prepare(
    `DELETE FROM envelope_moves
      WHERE (from_type = ? AND from_id IN (${idPh}))
         OR (to_type = ? AND to_id IN (${idPh}))`,
  ).run(type, ...ids, type, ...ids);
}
