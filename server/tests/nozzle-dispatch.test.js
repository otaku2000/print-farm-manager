// The nozzle-size skip (server/nozzle-compat.js): dispatch and the dispatch-status
// diagnostic must agree that a printer with the wrong nozzle cannot take a part, and the
// scheduler must fall through to a part the printer can print.

const path = require('path');
const fs   = require('fs');
const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// A driver that reports a nozzle mismatch for any file named *_0.6.3mf.
const mockDriver = {
  uploadAndPrint: jest.fn(),
  checkIfPrinting: jest.fn(),
  nozzleMismatch: jest.fn((printer, fullPath) =>
    fullPath.endsWith('_0.6.3mf') ? 'the file is sliced for a 0.6 mm nozzle but the nozzle is 0.4 mm' : null),
};
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const JobScheduler = require('../scheduler');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const stamp = Date.now();
const FILE_06 = `nozzle_test_${stamp}_0.6.3mf`;
const FILE_04 = `nozzle_test_${stamp}_0.4.3mf`;

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  for (const f of [FILE_06, FILE_04]) fs.writeFileSync(path.join(GCODE_DIR, f), 'x');
});
afterAll(() => {
  for (const f of [FILE_06, FILE_04]) { try { fs.unlinkSync(path.join(GCODE_DIR, f)); } catch (_) {} }
});
beforeEach(() => {
  jest.clearAllMocks();
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
});

// Two open parts in one project: the higher one (sort 0) only has a 0.6 mm file.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT DEFAULT '', api_key TEXT DEFAULT '',
      model TEXT NOT NULL, type TEXT DEFAULT 'bambu', group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER DEFAULT 0, print_time_seconds INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER,
      ams_slot INTEGER, allowed_groups TEXT, required_material TEXT, required_color TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('dispatch_batch_size', '10');
  `);
  const now = Date.now();
  db.prepare("INSERT INTO printers (name, model) VALUES ('BL-H2S-004', 'h2s')").run();
  db.prepare("INSERT INTO projects (name) VALUES ('Proj')").run();
  db.prepare("INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (1, 'Big Nozzle Part', 5, 0, ?, ?)").run(now, now);
  db.prepare("INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (1, 'Normal Part', 5, 1, ?, ?)").run(now, now);
  const g = db.prepare("INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?, 'h2s', ?, ?, 1, ?)");
  g.run(1, FILE_06, FILE_06, now);
  g.run(2, FILE_04, FILE_04, now);
  return db;
}

const printerRow = db => db.prepare('SELECT * FROM printers WHERE id = 1').get();

test('dispatch skips the part sliced for another nozzle and takes the next one', async () => {
  const db = makeDb();
  const scheduler = new JobScheduler(db, { on: () => {} });

  const jobId = await scheduler._dispatchToPrinter(printerRow(db));

  expect(jobId).not.toBeNull();
  expect(mockDriver.uploadAndPrint).toHaveBeenCalledTimes(1);
  expect(mockDriver.uploadAndPrint.mock.calls[0][2]).toBe(FILE_04);
  // The probe job for the skipped part was removed, not left behind.
  expect(db.prepare('SELECT part_id, status FROM jobs').all()).toEqual([{ part_id: 2, status: 'printing' }]);
});

test('no dispatch when the only part needs another nozzle', async () => {
  const db = makeDb();
  db.prepare("UPDATE parts SET status = 'complete' WHERE id = 2").run();
  const scheduler = new JobScheduler(db, { on: () => {} });

  expect(await scheduler._dispatchToPrinter(printerRow(db))).toBeNull();
  expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
});

test('dispatch-status shows the printer as wrong_nozzle with the reason, and the part as unmatched', async () => {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  app.use('/api/parts', require('../routes/parts')(db));

  const res = await request(app).get('/api/parts/1/dispatch-status');

  expect(res.status).toBe(200);
  const printer = res.body.gcodes[0].printers[0];
  expect(printer.state).toBe('wrong_nozzle');
  expect(printer.nozzle_problem).toMatch(/0\.6 mm nozzle/);
  expect(res.body.dispatchable).toBe(false);
  expect(res.body.gcodes[0].mismatch).toMatch(/0\.6 mm nozzle .* on every matching printer/);

  // The part it can print is ready, and is what this printer would get next.
  const other = await request(app).get('/api/parts/2/dispatch-status');
  expect(other.body.gcodes[0].printers[0]).toMatchObject({ state: 'ready', next_up: { part_id: 2, is_this_part: true } });
});
