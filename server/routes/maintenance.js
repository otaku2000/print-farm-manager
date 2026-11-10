const express = require('express');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DEFAULT_DAYS = 90;
const DEFAULT_HOURS = 2000;

function parsePositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null;
}

module.exports = (db) => {
  const router = express.Router();

  function defaults() {
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('maintenance_interval_days', 'maintenance_interval_hours')"
    ).all();
    const m = {};
    rows.forEach(r => { m[r.key] = parseInt(r.value, 10); });
    return {
      days:  m.maintenance_interval_days  > 0 ? m.maintenance_interval_days  : DEFAULT_DAYS,
      hours: m.maintenance_interval_hours > 0 ? m.maintenance_interval_hours : DEFAULT_HOURS,
    };
  }

  // Print hours since `since`: time between started_at and finished_at for jobs that
  // actually ran on this printer (finished, failed, or cancelled mid-print).
  function hoursSince(printerId, since) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(finished_at - started_at), 0) AS ms
      FROM jobs
      WHERE printer_id = ? AND started_at IS NOT NULL AND finished_at IS NOT NULL
        AND finished_at > started_at AND started_at >= ?
    `).get(printerId, since);
    return row.ms / HOUR_MS;
  }

  function statusFor(printer, def, now) {
    const last = db.prepare(
      'SELECT performed_at FROM printer_maintenance WHERE printer_id = ? ORDER BY performed_at DESC, id DESC LIMIT 1'
    ).get(printer.id);
    const since = last ? last.performed_at : printer.created_at;
    const intervalDays  = printer.maintenance_interval_days  || def.days;
    const intervalHours = printer.maintenance_interval_hours || def.hours;
    const daysSince  = Math.max(0, (now - since) / DAY_MS);
    const hoursUsed  = hoursSince(printer.id, since);
    const overdueDays  = daysSince >= intervalDays;
    const overdueHours = hoursUsed >= intervalHours;
    return {
      printer_id: printer.id,
      name: printer.name,
      model: printer.model,
      group_name: printer.group_name,
      last_performed_at: last ? last.performed_at : null,
      since,
      // When the day interval runs out: the last service (or the date the printer was
      // added) plus interval_days. The print-hour limit can come due sooner.
      next_due_at: since + intervalDays * DAY_MS,
      days_since: Math.round(daysSince * 10) / 10,
      print_hours_since: Math.round(hoursUsed * 10) / 10,
      interval_days: intervalDays,
      interval_hours: intervalHours,
      custom_days: printer.maintenance_interval_days ?? null,
      custom_hours: printer.maintenance_interval_hours ?? null,
      overdue: overdueDays || overdueHours,
      overdue_reason: overdueDays && overdueHours ? 'both' : overdueDays ? 'days' : overdueHours ? 'hours' : null,
    };
  }

  // GET /api/maintenance: maintenance status for every active printer, overdue first
  router.get('/', (req, res) => {
    const def = defaults();
    const now = Date.now();
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 1 ORDER BY name').all();
    const list = printers.map(p => statusFor(p, def, now));
    list.sort((a, b) => (b.overdue - a.overdue) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({
      defaults: { interval_days: def.days, interval_hours: def.hours },
      overdue_count: list.filter(p => p.overdue).length,
      printers: list,
    });
  });

  // GET /api/maintenance/:printerId/history
  router.get('/:printerId/history', (req, res) => {
    const id = parseInt(req.params.printerId, 10);
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(db.prepare(
      'SELECT * FROM printer_maintenance WHERE printer_id = ? ORDER BY performed_at DESC, id DESC'
    ).all(id));
  });

  // POST /api/maintenance/:printerId/done: log a service and restart both clocks
  router.post('/:printerId/done', (req, res) => {
    const id = parseInt(req.params.printerId, 10);
    const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const now = Date.now();
    let performedAt = now;
    if (req.body.performed_at !== undefined && req.body.performed_at !== null) {
      performedAt = Number(req.body.performed_at);
      if (!Number.isFinite(performedAt) || performedAt > now + 60000 || performedAt < 0) {
        return res.status(400).json({ error: 'performed_at must be a past timestamp in milliseconds' });
      }
    }
    const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null;

    const info = db.prepare(
      'INSERT INTO printer_maintenance (printer_id, performed_at, note, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, performedAt, note, now);
    console.log(`[maintenance] ${printer.name} serviced`);
    const row = db.prepare('SELECT * FROM printer_maintenance WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  });

  // PUT /api/maintenance/:printerId/intervals: per-printer override.
  // Send null (or omit the key) to fall back to the farm default for that interval.
  router.put('/:printerId/intervals', (req, res) => {
    const id = parseInt(req.params.printerId, 10);
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const out = {};
    for (const key of ['interval_days', 'interval_hours']) {
      const v = req.body[key];
      if (v === undefined || v === null || v === '') { out[key] = null; continue; }
      const n = parsePositiveInt(v);
      if (n === null) return res.status(400).json({ error: `${key} must be an integer between 1 and 100000, or null` });
      out[key] = n;
    }
    db.prepare('UPDATE printers SET maintenance_interval_days = ?, maintenance_interval_hours = ? WHERE id = ?')
      .run(out.interval_days, out.interval_hours, id);
    res.json(statusFor(db.prepare('SELECT * FROM printers WHERE id = ?').get(id), defaults(), Date.now()));
  });

  // DELETE /api/maintenance/entry/:entryId: remove a mistaken log entry
  router.delete('/entry/:entryId', (req, res) => {
    const id = parseInt(req.params.entryId, 10);
    const row = db.prepare('SELECT id FROM printer_maintenance WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Maintenance entry not found' });
    db.prepare('DELETE FROM printer_maintenance WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
};
