// Quick prints (server/quick-prints.js, server/routes/quick-prints.js): one-off prints as
// parts of a built-in project that stays ahead of all project work.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const { candidateSql, SCHEDULER_COLUMNS } = require('../candidate-query');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'draft', priority INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0, print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER, ams_slot INTEGER, allowed_groups TEXT,
      required_material TEXT, required_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued', started_at INTEGER, created_at INTEGER DEFAULT 0
    );
  `);
  // Route modules that declare their router at module scope keep a stale db between tests.
  jest.resetModules();
  app = express();
  app.use(express.json());
  app.use('/api/quick-prints', require('../routes/quick-prints')(db));
  app.use('/api/projects', require('../routes/projects')(db, null));
});

const quickProject = () => db.prepare(
  "SELECT * FROM projects WHERE id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'quick_print_project_id')"
).get();

describe('POST /api/quick-prints/parts', () => {
  test('creates the built-in project once, active and ahead of all projects', async () => {
    const a = await request(app).post('/api/quick-prints/parts').send({ name: 'Bracket', copies: 2, parts_per_plate: 3 });
    expect(a.status).toBe(201);
    expect(a.body.part).toMatchObject({ name: 'Bracket', target_qty: 6, status: 'open', sort_order: 0 });

    const b = await request(app).post('/api/quick-prints/parts').send({ name: 'Clip', copies: 1 });
    expect(b.body.project_id).toBe(a.body.project_id);
    expect(b.body.part).toMatchObject({ target_qty: 1, sort_order: 1 });

    expect(quickProject()).toMatchObject({ name: 'Quick prints', status: 'active', priority: -1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(1);
  });

  test('400 with the missing fields named, and nothing created', async () => {
    const res = await request(app).post('/api/quick-prints/parts').send({ name: ' ', copies: 0, parts_per_plate: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name.*copies.*parts_per_plate/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n).toBe(0);
  });

  test('reopens the project after every quick print finished, but leaves a paused one paused', async () => {
    await request(app).post('/api/quick-prints/parts').send({ name: 'A', copies: 1 });
    db.prepare("UPDATE projects SET status = 'completed'").run();
    await request(app).post('/api/quick-prints/parts').send({ name: 'B', copies: 1 });
    expect(quickProject().status).toBe('active');

    db.prepare("UPDATE projects SET status = 'paused'").run();
    await request(app).post('/api/quick-prints/parts').send({ name: 'C', copies: 1 });
    expect(quickProject().status).toBe('paused');
  });

  test('a deleted quick-print project is recreated on the next quick print', async () => {
    const first = await request(app).post('/api/quick-prints/parts').send({ name: 'A', copies: 1 });
    db.prepare('DELETE FROM parts').run();
    db.prepare('DELETE FROM projects').run();
    const second = await request(app).post('/api/quick-prints/parts').send({ name: 'B', copies: 1 });
    expect(second.status).toBe(201);
    expect(second.body.project_id).not.toBe(first.body.project_id);
    expect(quickProject().priority).toBe(-1);
  });
});

describe('GET /api/quick-prints', () => {
  test('no project yet: empty list, and nothing is created', async () => {
    const res = await request(app).get('/api/quick-prints');
    expect(res.body).toEqual({ project: null, parts: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(0);
  });

  test('lists quick prints newest first with their file and active jobs', async () => {
    const a = (await request(app).post('/api/quick-prints/parts').send({ name: 'Older', copies: 1 })).body.part;
    db.prepare('UPDATE parts SET created_at = created_at - 1000 WHERE id = ?').run(a.id);
    const b = (await request(app).post('/api/quick-prints/parts').send({ name: 'Newer', copies: 1 })).body.part;
    db.prepare("INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'h2s', 'clip.gcode.3mf', 'x', 1, 0)").run(b.id);
    db.prepare("INSERT INTO printers (name) VALUES ('BL-H2S-003')").run();
    db.prepare("INSERT INTO jobs (part_id, printer_id, parts_per_plate, status) VALUES (?, 1, 1, 'printing')").run(b.id);

    const res = await request(app).get('/api/quick-prints');
    expect(res.body.project).toMatchObject({ name: 'Quick prints', status: 'active' });
    expect(res.body.parts.map(p => p.name)).toEqual(['Newer', 'Older']);
    expect(res.body.parts[0].gcode).toMatchObject({ filename: 'clip.gcode.3mf', printer_model: 'h2s' });
    expect(res.body.parts[0].active_jobs).toEqual([expect.objectContaining({ status: 'printing', printer_name: 'BL-H2S-003' })]);
    expect(res.body.parts[1]).toMatchObject({ gcode: null, active_jobs: [] });
  });
});

describe('priority', () => {
  test('dragging projects in the Projects list never moves quick prints down', async () => {
    const quickId = (await request(app).post('/api/quick-prints/parts').send({ name: 'A', copies: 1 })).body.project_id;
    const now = Date.now();
    const p1 = db.prepare("INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Big job', 'active', ?, ?)").run(now, now).lastInsertRowid;
    const p2 = db.prepare("INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Other', 'active', ?, ?)").run(now, now).lastInsertRowid;

    const res = await request(app).put('/api/projects/reorder').send({ ids: [p2, quickId, p1] });
    expect(res.status).toBe(200);
    const pri = Object.fromEntries(db.prepare('SELECT id, priority FROM projects').all().map(r => [r.id, r.priority]));
    expect(pri).toEqual({ [quickId]: -1, [p2]: 0, [p1]: 1 });
  });

  test('the scheduler candidate query picks a quick print before older project work', async () => {
    const now = Date.now();
    const proj = db.prepare("INSERT INTO projects (name, status, created_at, updated_at) VALUES ('Big job', 'active', ?, ?)").run(now - 100000, now).lastInsertRowid;
    const projPart = db.prepare("INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (?, 'Panel', 50, ?, ?)").run(proj, now - 100000, now).lastInsertRowid;
    const quickPart = (await request(app).post('/api/quick-prints/parts').send({ name: 'Urgent clip', copies: 1 })).body.part.id;
    const g = db.prepare("INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'h2s', ?, ?, 1, 0)");
    g.run(projPart, 'panel.3mf', 'panel.3mf');
    g.run(quickPart, 'clip.3mf', 'clip.3mf');

    const filaments = JSON.stringify([{ material: null, color: null, slot: null }]);
    const first = db.prepare(candidateSql(SCHEDULER_COLUMNS)).get('h2s', null, filaments);
    expect(first.part_id).toBe(quickPart);
    const next = db.prepare(candidateSql(SCHEDULER_COLUMNS, 1)).get('h2s', null, filaments, quickPart);
    expect(next.part_id).toBe(projPart);
  });
});
