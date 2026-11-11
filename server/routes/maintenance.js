const express = require('express');
const maintenanceTasks = require('../maintenance-tasks');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
// A task is "due soon" when it is within this many days of its date limit, or has used this
// share of its print-hour limit. Warnings only.
const DUE_SOON_DAYS = 14;
const DUE_SOON_HOURS_SHARE = 0.9;
const MAX_INTERVAL = 100000;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;

// A positive whole number up to MAX_INTERVAL, null for "no limit", or undefined when invalid.
function parseInterval(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL ? n : undefined;
}

// Maintenance tasks per printer (server/maintenance-tasks.js). Each active task has its own
// interval in days and/or print hours; its clock restarts at the latest log entry for that
// task, or the latest full service (task_id NULL), or else when the printer was added.
// Warnings only: nothing here affects dispatch.
module.exports = (db) => {
  const router = express.Router();
  maintenanceTasks.ensureSchema(db);

  const activeTasks = () => db.prepare(
    'SELECT * FROM maintenance_tasks WHERE is_active = 1 ORDER BY sort_order, id'
  ).all();

  // Print hours since `since`: time between started_at and finished_at for jobs that
  // actually ran on this printer (finished, failed, or cancelled mid-print).
  const hoursStmt = db.prepare(`
    SELECT COALESCE(SUM(finished_at - started_at), 0) AS ms
    FROM jobs
    WHERE printer_id = ? AND started_at IS NOT NULL AND finished_at IS NOT NULL
      AND finished_at > started_at AND started_at >= ?
  `);
  const lastStmt = db.prepare(`
    SELECT MAX(performed_at) AS at FROM printer_maintenance
    WHERE printer_id = ? AND (task_id = ? OR task_id IS NULL)
  `);

  function taskStatus(printer, task, now) {
    const last = lastStmt.get(printer.id, task.id).at;
    const since = last ?? printer.created_at;
    const daysSince = Math.max(0, (now - since) / DAY_MS);
    const hoursUsed = hoursStmt.get(printer.id, since).ms / HOUR_MS;
    const overdueDays  = task.interval_days  != null && daysSince >= task.interval_days;
    const overdueHours = task.interval_hours != null && hoursUsed >= task.interval_hours;
    const dueSoon = !overdueDays && !overdueHours && (
      (task.interval_days  != null && task.interval_days - daysSince <= DUE_SOON_DAYS) ||
      (task.interval_hours != null && hoursUsed >= task.interval_hours * DUE_SOON_HOURS_SHARE));
    return {
      task_id: task.id,
      last_performed_at: last ?? null,
      since,
      days_since: Math.round(daysSince * 10) / 10,
      print_hours_since: Math.round(hoursUsed * 10) / 10,
      interval_days: task.interval_days,
      interval_hours: task.interval_hours,
      // When the day limit runs out; the print-hour limit can come due sooner.
      next_due_at: task.interval_days != null ? since + task.interval_days * DAY_MS : null,
      overdue: overdueDays || overdueHours,
      overdue_reason: overdueDays && overdueHours ? 'both' : overdueDays ? 'days' : overdueHours ? 'hours' : null,
      due_soon: dueSoon,
    };
  }

  function printerStatus(printer, tasks, now) {
    const list = tasks.map(t => taskStatus(printer, t, now));
    const dates = list.map(t => t.next_due_at).filter(v => v != null);
    const lastAny = db.prepare('SELECT MAX(performed_at) AS at FROM printer_maintenance WHERE printer_id = ?').get(printer.id).at;
    return {
      printer_id: printer.id,
      name: printer.name,
      model: printer.model,
      group_name: printer.group_name,
      overdue: list.some(t => t.overdue),
      overdue_count: list.filter(t => t.overdue).length,
      due_soon_count: list.filter(t => t.due_soon).length,
      next_due_at: dates.length ? Math.min(...dates) : null,
      last_performed_at: lastAny ?? null,
      tasks: list,
    };
  }

  // GET /api/maintenance: the active tasks and every active printer's status per task,
  // printers with overdue tasks first.
  router.get('/', (req, res) => {
    const now = Date.now();
    const tasks = activeTasks();
    const printers = db.prepare('SELECT * FROM printers WHERE is_active = 1 ORDER BY name').all();
    const list = printers.map(p => printerStatus(p, tasks, now));
    list.sort((a, b) => (b.overdue - a.overdue) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({
      tasks,
      overdue_count: list.filter(p => p.overdue).length,
      printers: list,
    });
  });

  // ── Task list (static paths before the /:printerId ones) ─────────────────────

  // GET /api/maintenance/tasks: every task, including disabled ones.
  router.get('/tasks', (req, res) => {
    res.json(db.prepare('SELECT * FROM maintenance_tasks ORDER BY sort_order, id').all());
  });

  function validateTask(body, existing) {
    const name = body.name !== undefined ? String(body.name).trim().slice(0, MAX_NAME) : existing?.name;
    const days = body.interval_days !== undefined ? parseInterval(body.interval_days) : existing?.interval_days ?? null;
    const hours = body.interval_hours !== undefined ? parseInterval(body.interval_hours) : existing?.interval_hours ?? null;
    const errors = [];
    if (!name) errors.push('name');
    if (days === undefined) errors.push(`interval_days (a whole number from 1 to ${MAX_INTERVAL}, or empty)`);
    if (hours === undefined) errors.push(`interval_hours (a whole number from 1 to ${MAX_INTERVAL}, or empty)`);
    if (days !== undefined && hours !== undefined && days == null && hours == null) {
      errors.push('at least one of interval_days or interval_hours');
    }
    const description = body.description !== undefined
      ? (String(body.description || '').trim().slice(0, MAX_DESCRIPTION) || null)
      : existing?.description ?? null;
    return { errors, value: { name, interval_days: days, interval_hours: hours, description } };
  }

  // POST /api/maintenance/tasks: add a task at the end of the list.
  router.post('/tasks', (req, res) => {
    const { errors, value } = validateTask(req.body, null);
    if (errors.length) return res.status(400).json({ error: `Invalid or missing: ${errors.join(', ')}` });
    const max = db.prepare('SELECT MAX(sort_order) AS m FROM maintenance_tasks').get().m;
    const info = db.prepare(`
      INSERT INTO maintenance_tasks (name, description, interval_days, interval_hours, sort_order, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(value.name, value.description, value.interval_days, value.interval_hours, (max ?? -1) + 1, Date.now());
    res.status(201).json(db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(info.lastInsertRowid));
  });

  // PUT /api/maintenance/tasks/:id: partial update of name, description, intervals (empty
  // clears one), and is_active (0 hides the task without losing its history).
  router.put('/tasks/:id', (req, res) => {
    const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Maintenance task not found' });
    const { errors, value } = validateTask(req.body, task);
    let isActive = task.is_active;
    if (req.body.is_active !== undefined) {
      if (![0, 1, true, false].includes(req.body.is_active)) errors.push('is_active (0 or 1)');
      else isActive = req.body.is_active ? 1 : 0;
    }
    if (errors.length) return res.status(400).json({ error: `Invalid or missing: ${errors.join(', ')}` });
    db.prepare(`
      UPDATE maintenance_tasks SET name = ?, description = ?, interval_days = ?, interval_hours = ?, is_active = ? WHERE id = ?
    `).run(value.name, value.description, value.interval_days, value.interval_hours, isActive, task.id);
    res.json(db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(task.id));
  });

  // DELETE /api/maintenance/tasks/:id: only a task never logged. One with history is
  // disabled instead (409), so the log keeps saying what was done.
  router.delete('/tasks/:id', (req, res) => {
    const task = db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Maintenance task not found' });
    const used = db.prepare('SELECT COUNT(*) AS n FROM printer_maintenance WHERE task_id = ?').get(task.id).n;
    if (used > 0) {
      return res.status(409).json({ error: `"${task.name}" has ${used} log entr${used === 1 ? 'y' : 'ies'}. Disable it instead to keep the history.` });
    }
    db.prepare('DELETE FROM maintenance_tasks WHERE id = ?').run(task.id);
    res.json({ ok: true });
  });

  // DELETE /api/maintenance/entry/:entryId: remove a mistaken log entry
  router.delete('/entry/:entryId', (req, res) => {
    const id = parseInt(req.params.entryId, 10);
    const row = db.prepare('SELECT id FROM printer_maintenance WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Maintenance entry not found' });
    db.prepare('DELETE FROM printer_maintenance WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ── Per printer ───────────────────────────────────────────────────────────────

  // GET /api/maintenance/:printerId/history: log entries, newest first, with task names
  // (task_name null = full service).
  router.get('/:printerId/history', (req, res) => {
    const id = parseInt(req.params.printerId, 10);
    if (!db.prepare('SELECT id FROM printers WHERE id = ?').get(id)) {
      return res.status(404).json({ error: 'Printer not found' });
    }
    res.json(db.prepare(`
      SELECT printer_maintenance.*, maintenance_tasks.name AS task_name
      FROM printer_maintenance LEFT JOIN maintenance_tasks ON maintenance_tasks.id = printer_maintenance.task_id
      WHERE printer_maintenance.printer_id = ?
      ORDER BY performed_at DESC, printer_maintenance.id DESC
    `).all(id));
  });

  // POST /api/maintenance/:printerId/done: log maintenance.
  // Body: { task_ids?: [ids], performed_at?: ms, note?: text }. With task_ids, one entry
  // per task restarts those tasks' clocks. Without (or empty), one full-service entry
  // restarts every task. performed_at defaults to now and must not be in the future.
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
    const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, MAX_DESCRIPTION) : null;

    let taskIds = [];
    if (req.body.task_ids !== undefined && req.body.task_ids !== null) {
      if (!Array.isArray(req.body.task_ids)) return res.status(400).json({ error: 'task_ids must be an array of task ids' });
      taskIds = [...new Set(req.body.task_ids.map(Number))];
      const known = new Set(db.prepare('SELECT id FROM maintenance_tasks').all().map(r => r.id));
      const bad = taskIds.filter(t => !known.has(t));
      if (bad.length) return res.status(400).json({ error: `Unknown task id(s): ${bad.join(', ')}` });
    }

    const insert = db.prepare(
      'INSERT INTO printer_maintenance (printer_id, performed_at, note, created_at, task_id) VALUES (?, ?, ?, ?, ?)'
    );
    const ids = db.transaction(() => (taskIds.length ? taskIds : [null])
      .map(t => insert.run(id, performedAt, note, now, t).lastInsertRowid))();
    console.log(`[maintenance] ${printer.name}: ${taskIds.length ? `${taskIds.length} task(s)` : 'full service'} logged`);
    const placeholders = ids.map(() => '?').join(',');
    res.status(201).json(db.prepare(`
      SELECT printer_maintenance.*, maintenance_tasks.name AS task_name
      FROM printer_maintenance LEFT JOIN maintenance_tasks ON maintenance_tasks.id = printer_maintenance.task_id
      WHERE printer_maintenance.id IN (${placeholders}) ORDER BY printer_maintenance.id
    `).all(...ids));
  });

  return router;
};
