const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

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
      is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL,
      maintenance_interval_days INTEGER, maintenance_interval_hours INTEGER
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
  db.prepare("INSERT INTO settings VALUES ('maintenance_interval_days', '90')").run();
  db.prepare("INSERT INTO settings VALUES ('maintenance_interval_hours', '2000')").run();

  app = express();
  app.use(express.json());
  app.use('/api/maintenance', require('../routes/maintenance')(db));
});

function addPrinter(name, ageDays, extra = {}) {
  const info = db.prepare(
    'INSERT INTO printers (name, model, created_at, is_active, maintenance_interval_days, maintenance_interval_hours) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, 'mk4s', Date.now() - ageDays * DAY, extra.is_active ?? 1, extra.days ?? null, extra.hours ?? null);
  return info.lastInsertRowid;
}

function addJob(printerId, startedAgoMs, hours) {
  const start = Date.now() - startedAgoMs;
  db.prepare('INSERT INTO jobs (printer_id, started_at, finished_at) VALUES (?, ?, ?)')
    .run(printerId, start, start + hours * HOUR);
}

async function statusOf(id) {
  const res = await request(app).get('/api/maintenance');
  return res.body.printers.find(p => p.printer_id === id);
}

describe('GET /api/maintenance', () => {
  test('a fresh printer is not overdue and uses the defaults', async () => {
    const id = addPrinter('A', 5);
    const s = await statusOf(id);
    expect(s.overdue).toBe(false);
    expect(s.interval_days).toBe(90);
    expect(s.interval_hours).toBe(2000);
  });

  test('overdue after 90 days with no service logged', async () => {
    const id = addPrinter('A', 91);
    const s = await statusOf(id);
    expect(s.overdue).toBe(true);
    expect(s.overdue_reason).toBe('days');
  });

  test('overdue after 2000 print hours even when recent', async () => {
    const id = addPrinter('A', 30);
    addJob(id, 10 * DAY, 2001);
    const s = await statusOf(id);
    expect(s.overdue).toBe(true);
    expect(s.overdue_reason).toBe('hours');
  });

  test('only hours since the last service count', async () => {
    const id = addPrinter('A', 120);
    addJob(id, 100 * DAY, 1500);
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() - 50 * DAY });
    addJob(id, 10 * DAY, 100);
    const s = await statusOf(id);
    expect(s.print_hours_since).toBeCloseTo(100, 0);
    expect(s.overdue).toBe(false);
  });

  test('overdue printers sort first and inactive printers are left out', async () => {
    addPrinter('A-ok', 1);
    addPrinter('B-late', 200);
    addPrinter('C-gone', 200, { is_active: 0 });
    const res = await request(app).get('/api/maintenance');
    expect(res.body.printers.map(p => p.name)).toEqual(['B-late', 'A-ok']);
    expect(res.body.overdue_count).toBe(1);
  });

  test('per-printer override beats the default', async () => {
    const id = addPrinter('A', 40, { days: 30 });
    const s = await statusOf(id);
    expect(s.interval_days).toBe(30);
    expect(s.custom_days).toBe(30);
    expect(s.overdue).toBe(true);
  });

  test('changing the default setting changes the threshold', async () => {
    const id = addPrinter('A', 40);
    db.prepare("UPDATE settings SET value = '30' WHERE key = 'maintenance_interval_days'").run();
    expect((await statusOf(id)).overdue).toBe(true);
  });
});

describe('POST /api/maintenance/:id/done', () => {
  test('logs a service, clears the warning, and returns 201', async () => {
    const id = addPrinter('A', 200);
    const res = await request(app).post(`/api/maintenance/${id}/done`).send({ note: ' cleaned rods ' });
    expect(res.status).toBe(201);
    expect(res.body.note).toBe('cleaned rods');
    expect((await statusOf(id)).overdue).toBe(false);
  });

  test('accepts a past performed_at and rejects a future one', async () => {
    const id = addPrinter('A', 200);
    const past = Date.now() - 100 * DAY;
    expect((await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: past })).status).toBe(201);
    expect((await statusOf(id)).overdue).toBe(true); // 100 days ago is still over 90
    const bad = await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() + 10 * DAY });
    expect(bad.status).toBe(400);
  });

  test('next_due_at is the last service plus the day interval, following overrides', async () => {
    const id = addPrinter('A', 200);
    const serviced = Date.now() - 10 * DAY;
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: serviced });
    expect((await statusOf(id)).next_due_at).toBe(serviced + 90 * DAY);
    await request(app).put(`/api/maintenance/${id}/intervals`).send({ interval_days: 30 });
    expect((await statusOf(id)).next_due_at).toBe(serviced + 30 * DAY);
  });

  test('next_due_at counts from when the printer was added if never serviced', async () => {
    const id = addPrinter('A', 100);
    const s = await statusOf(id);
    expect(s.next_due_at).toBe(s.since + 90 * DAY);
    expect(s.next_due_at).toBeLessThan(Date.now()); // 100 days old, so already past due
  });

  test('back-filling an older date from the calendar does not replace a newer service', async () => {
    const id = addPrinter('A', 200);
    const recent = Date.now() - 5 * DAY;
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: recent });
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() - 60 * DAY });
    const s = await statusOf(id);
    expect(s.last_performed_at).toBe(recent);
    expect(s.days_since).toBeCloseTo(5, 0);
  });

  test('404 for an unknown printer', async () => {
    expect((await request(app).post('/api/maintenance/999/done').send({})).status).toBe(404);
  });
});

describe('PUT /api/maintenance/:id/intervals', () => {
  test('sets and clears overrides', async () => {
    const id = addPrinter('A', 1);
    let res = await request(app).put(`/api/maintenance/${id}/intervals`).send({ interval_days: 14, interval_hours: 300 });
    expect(res.status).toBe(200);
    expect(res.body.interval_days).toBe(14);
    expect(res.body.interval_hours).toBe(300);
    res = await request(app).put(`/api/maintenance/${id}/intervals`).send({ interval_days: null, interval_hours: null });
    expect(res.body.interval_days).toBe(90);
    expect(res.body.custom_days).toBeNull();
  });

  test('rejects zero, negatives, and non-integers', async () => {
    const id = addPrinter('A', 1);
    for (const bad of [0, -5, 1.5, 'abc']) {
      const res = await request(app).put(`/api/maintenance/${id}/intervals`).send({ interval_days: bad });
      expect(res.status).toBe(400);
    }
  });

  test('404 for an unknown printer', async () => {
    expect((await request(app).put('/api/maintenance/999/intervals').send({})).status).toBe(404);
  });
});

describe('history and delete', () => {
  test('lists entries newest first and deleting one restarts the clock from the earlier one', async () => {
    const id = addPrinter('A', 300);
    await request(app).post(`/api/maintenance/${id}/done`).send({ performed_at: Date.now() - 200 * DAY });
    const recent = await request(app).post(`/api/maintenance/${id}/done`).send({});
    const hist = await request(app).get(`/api/maintenance/${id}/history`);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].id).toBe(recent.body.id);
    expect((await statusOf(id)).overdue).toBe(false);
    expect((await request(app).delete(`/api/maintenance/entry/${recent.body.id}`)).status).toBe(200);
    expect((await statusOf(id)).overdue).toBe(true);
    expect((await request(app).delete('/api/maintenance/entry/9999')).status).toBe(404);
  });

  test('history 404 for unknown printer', async () => {
    expect((await request(app).get('/api/maintenance/999/history')).status).toBe(404);
  });
});
