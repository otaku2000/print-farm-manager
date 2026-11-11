// Maintenance tasks (server/maintenance-tasks.js, server/routes/maintenance.js): separate
// jobs, each with its own interval, tracked per printer.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { DEFAULT_TASKS } = require('../maintenance-tasks');

const DAY = 86400000;
const HOUR = 3600000;

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, model TEXT, group_name TEXT,
      is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE printer_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL,
      performed_at INTEGER NOT NULL, note TEXT, created_at INTEGER NOT NULL
    );
  `);
  app = express();
  app.use(express.json());
  app.use('/api/maintenance', require('../routes/maintenance')(db));
});

function addPrinter(name, ageDays, extra = {}) {
  return db.prepare('INSERT INTO printers (name, model, created_at, is_active) VALUES (?, ?, ?, ?)')
    .run(name, 'h2s', Date.now() - ageDays * DAY, extra.is_active ?? 1).lastInsertRowid;
}

function addJob(printerId, startedAgoMs, hours) {
  const start = Date.now() - startedAgoMs;
  db.prepare('INSERT INTO jobs (printer_id, started_at, finished_at) VALUES (?, ?, ?)')
    .run(printerId, start, start + hours * HOUR);
}

const taskId = name => db.prepare('SELECT id FROM maintenance_tasks WHERE name = ?').get(name).id;

async function statusOf(id) {
  const res = await request(app).get('/api/maintenance');
  return res.body.printers.find(p => p.printer_id === id);
}
const taskStatus = (printer, name) => printer.tasks.find(t => t.task_id === taskId(name));

describe('task list setup', () => {
  test('seeds the default tasks once, including the requested jobs', async () => {
    const names = (await request(app).get('/api/maintenance/tasks')).body.map(t => t.name);
    expect(names).toEqual(DEFAULT_TASKS.map(t => t.name));
    for (const wanted of ['Clean the nozzle and check for clogs', 'Clean and lube the rods', 'Clean and grease the lead screws',
      'Replace the filters', 'Clean the build plate']) {
      expect(names).toContain(wanted);
    }
  });

  test('a deleted default task does not come back on the next start', async () => {
    const id = taskId('Check belt tension');
    expect((await request(app).delete(`/api/maintenance/tasks/${id}`)).status).toBe(200);
    require('../routes/maintenance')(db); // a restart re-runs the schema setup
    const names = db.prepare('SELECT name FROM maintenance_tasks').all().map(r => r.name);
    expect(names).not.toContain('Check belt tension');
    expect(names).toHaveLength(DEFAULT_TASKS.length - 1);
  });
});

describe('GET /api/maintenance', () => {
  test('every active task is tracked per printer, from when the printer was added', async () => {
    const id = addPrinter('A', 10);
    const s = await statusOf(id);
    expect(s.tasks).toHaveLength(DEFAULT_TASKS.length);
    const plate = taskStatus(s, 'Clean the build plate'); // every 7 days
    expect(plate).toMatchObject({ overdue: true, overdue_reason: 'days', interval_days: 7, last_performed_at: null });
    expect(taskStatus(s, 'Replace the filters')).toMatchObject({ overdue: false, interval_days: 90 });
    expect(s.overdue).toBe(true);
    expect(s.overdue_count).toBeGreaterThanOrEqual(1);
  });

  test('a task comes due on print hours alone', async () => {
    const id = addPrinter('A', 1);
    addJob(id, 20 * HOUR, 120); // past the build plate's 100 print hours
    const plate = taskStatus(await statusOf(id), 'Clean the build plate');
    expect(plate).toMatchObject({ overdue: true, overdue_reason: 'hours' });
    expect(plate.print_hours_since).toBeCloseTo(120, 0);
  });

  test('due soon within 14 days of the date limit', async () => {
    const id = addPrinter('A', 80); // filters every 90 days: 10 left
    const filters = taskStatus(await statusOf(id), 'Replace the filters');
    expect(filters).toMatchObject({ overdue: false, due_soon: true });
  });

  test('disabled tasks are not tracked', async () => {
    const id = addPrinter('A', 30);
    await request(app).put(`/api/maintenance/tasks/${taskId('Clean the build plate')}`).send({ is_active: 0 });
    const s = await statusOf(id);
    expect(s.tasks.map(t => t.task_id)).not.toContain(taskId('Clean the build plate'));
  });

  test('printers with overdue tasks sort first; inactive printers are left out', async () => {
    addPrinter('A-new', 1);
    addPrinter('B-old', 200);
    addPrinter('C-gone', 200, { is_active: 0 });
    const res = await request(app).get('/api/maintenance');
    expect(res.body.printers.map(p => p.name)).toEqual(['B-old', 'A-new']);
    expect(res.body.overdue_count).toBe(1);
    expect(res.body.tasks.length).toBe(DEFAULT_TASKS.length);
  });
});

describe('POST /api/maintenance/:id/done', () => {
  test('logging one task restarts only that task', async () => {
    const id = addPrinter('A', 30);
    const res = await request(app).post(`/api/maintenance/${id}/done`)
      .send({ task_ids: [taskId('Clean the build plate')], note: ' washed ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({ task_name: 'Clean the build plate', note: 'washed' })]);
    const s = await statusOf(id);
    expect(taskStatus(s, 'Clean the build plate').overdue).toBe(false);
    expect(taskStatus(s, 'Clean the purge chute and nozzle wiper').overdue).toBe(true); // 14 days, untouched
  });

  test('a full service (no task_ids) restarts every task, like entries logged before tasks existed', async () => {
    const id = addPrinter('A', 400);
    const res = await request(app).post(`/api/maintenance/${id}/done`).send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({ task_id: null, task_name: null })]);
    const s = await statusOf(id);
    expect(s.overdue).toBe(false);
    expect(s.tasks.every(t => t.last_performed_at != null)).toBe(true);

    // An old-style row (no task_id) written before tasks existed counts the same way.
    const old = addPrinter('B', 400);
    db.prepare('INSERT INTO printer_maintenance (printer_id, performed_at, created_at) VALUES (?, ?, ?)').run(old, Date.now() - DAY, Date.now());
    expect((await statusOf(old)).overdue).toBe(false);
  });

  test('a past date from the calendar, and next_due_at from it', async () => {
    const id = addPrinter('A', 200);
    const when = Date.now() - 10 * DAY;
    await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [taskId('Replace the filters')], performed_at: when });
    const filters = taskStatus(await statusOf(id), 'Replace the filters');
    expect(filters.last_performed_at).toBe(when);
    expect(filters.next_due_at).toBe(when + 90 * DAY);
  });

  test('a newer task entry wins over an older full service, and an older entry never replaces a newer one', async () => {
    const id = addPrinter('A', 200);
    const recent = Date.now() - 2 * DAY;
    await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [taskId('Clean the build plate')], performed_at: recent });
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() - 30 * DAY });
    expect(taskStatus(await statusOf(id), 'Clean the build plate').last_performed_at).toBe(recent);
  });

  test('400 for a future date, an unknown task, or task_ids that is not a list; 404 for an unknown printer', async () => {
    const id = addPrinter('A', 1);
    expect((await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() + 10 * DAY })).status).toBe(400);
    expect((await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [9999] })).status).toBe(400);
    expect((await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: 'all' })).status).toBe(400);
    expect((await request(app).post('/api/maintenance/999/done').send({})).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM printer_maintenance').get().n).toBe(0);
  });
});

describe('history and entries', () => {
  test('history names each task, full service as null, newest first', async () => {
    const id = addPrinter('A', 30);
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() - 5 * DAY });
    await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [taskId('Clean the build plate')] });
    const res = await request(app).get(`/api/maintenance/${id}/history`);
    expect(res.body.map(h => h.task_name)).toEqual(['Clean the build plate', null]);
    expect((await request(app).get('/api/maintenance/999/history')).status).toBe(404);
  });

  test('deleting an entry puts the task back to its previous state', async () => {
    const id = addPrinter('A', 30);
    const row = (await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [taskId('Clean the build plate')] })).body[0];
    expect((await request(app).delete(`/api/maintenance/entry/${row.id}`)).status).toBe(200);
    expect(taskStatus(await statusOf(id), 'Clean the build plate').overdue).toBe(true);
    expect((await request(app).delete('/api/maintenance/entry/999')).status).toBe(404);
  });
});

describe('task editing', () => {
  test('add a task with only a print-hour limit', async () => {
    const res = await request(app).post('/api/maintenance/tasks').send({ name: 'Lubricate the Z rails', interval_hours: 300 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Lubricate the Z rails', interval_days: null, interval_hours: 300, is_active: 1, sort_order: DEFAULT_TASKS.length });
  });

  test('400 without a name or without any interval, or with a bad interval', async () => {
    expect((await request(app).post('/api/maintenance/tasks').send({ interval_days: 5 })).status).toBe(400);
    expect((await request(app).post('/api/maintenance/tasks').send({ name: 'X' })).status).toBe(400);
    expect((await request(app).post('/api/maintenance/tasks').send({ name: 'X', interval_days: 0 })).status).toBe(400);
    expect((await request(app).post('/api/maintenance/tasks').send({ name: 'X', interval_days: 1.5 })).status).toBe(400);
  });

  test('rename, retime, clear one limit, and disable', async () => {
    const id = taskId('Replace the filters');
    let res = await request(app).put(`/api/maintenance/tasks/${id}`).send({ name: 'Replace carbon filter', interval_days: 60, interval_hours: '' });
    expect(res.body).toMatchObject({ name: 'Replace carbon filter', interval_days: 60, interval_hours: null, is_active: 1 });
    res = await request(app).put(`/api/maintenance/tasks/${id}`).send({ is_active: false });
    expect(res.body.is_active).toBe(0);
    expect((await request(app).put(`/api/maintenance/tasks/${id}`).send({ interval_days: '' })).status).toBe(400); // would leave no limit
    expect((await request(app).put('/api/maintenance/tasks/9999').send({ name: 'x' })).status).toBe(404);
  });

  test('a task with log entries cannot be deleted, only disabled', async () => {
    const id = addPrinter('A', 1);
    const t = taskId('Clean the build plate');
    await request(app).post(`/api/maintenance/${id}/done`).send({ task_ids: [t] });
    const res = await request(app).delete(`/api/maintenance/tasks/${t}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Disable it instead/);
    expect((await request(app).delete('/api/maintenance/tasks/9999')).status).toBe(404);
  });
});
