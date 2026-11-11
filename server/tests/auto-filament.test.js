// Auto filament: a Bambu printer with filament_auto = 1 matches parts against the spools
// its AMS reports (server/printer-filaments.js), through the shared candidate query.
// The Bambu driver is mocked: getLoadedFilament returns whatever a test sets.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const mockDriver = { uploadAndPrint: jest.fn(), checkIfPrinting: jest.fn() };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../drivers/bambu', () => ({ getLoadedFilament: jest.fn() }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const bambu = require('../drivers/bambu');
const JobScheduler = require('../scheduler');
const pf = require('../printer-filaments');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
let gcodeFilename;
beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  gcodeFilename = `auto_filament_test_${Date.now()}.3mf`;
  fs.writeFileSync(path.join(GCODE_DIR, gcodeFilename), 'x');
});
afterAll(() => { try { fs.unlinkSync(path.join(GCODE_DIR, gcodeFilename)); } catch (_) {} });

beforeEach(() => {
  jest.clearAllMocks();
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
});

// Trays shaped like getLoadedFilament's output, from BL-H2S-004's real AMS.
function tray(slot, type, name, color) {
  return { slot, ams_id: 0, slot_id: slot, type, name, color, remain: null };
}
const H2S_004 = {
  trays: [
    tray(0, 'ABS-GF', 'ABS-GF', '000000'),
    tray(1, 'PETG', 'PETG HF', '000000'),
    tray(2, 'ABS-GF', 'ABS-GF', '0C3B95'),
    tray(3, 'PET-CF', 'PET-CF', '000000'),
  ],
  external: null,
  active_slot: null,
};

function makeDb({ filamentAuto = 1, type = 'bambu', reqMaterial = 'PETG HF', reqColor = 'Black', amsSlot = 3,
                  blackHex = '#000000' } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa',
      group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      filament_auto INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT,
      allowed_groups TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0, print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('dispatch_batch_size', '10');
    CREATE TABLE filament_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE filament_colors (id INTEGER PRIMARY KEY, type_id INTEGER, name TEXT, hex_color TEXT);
  `);
  // The farm's library: PETG HF has Black (hex as given), White and Blue.
  db.prepare("INSERT INTO filament_types (id, name) VALUES (1, 'PETG HF'), (2, 'ABS-GF'), (3, 'PETG')").run();
  db.prepare('INSERT INTO filament_colors (type_id, name, hex_color) VALUES (1, ?, ?)').run('Black', blackHex);
  db.prepare("INSERT INTO filament_colors (type_id, name, hex_color) VALUES (1, 'White', '#ffffff'), (1, 'Blue', '#0000ff'), (2, 'Black', '#000000')").run();

  const now = Date.now();
  db.prepare(`INSERT INTO printers (name, ip, api_key, model, type, loaded_material, loaded_color, filament_auto, created_at)
              VALUES ('BL-H2S-004', '10.0.0.4', 'k', 'h2s', ?, 'PLA', 'Red', ?, ?)`).run(type, filamentAuto, now);
  db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Proj', ?, ?)").run(now, now);
  db.prepare("INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (1, 'Servo Mount', 10, ?, ?)").run(now, now);
  db.prepare(`INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, ams_slot, required_material, required_color, created_at)
              VALUES (1, 'h2s', ?, ?, 1, ?, ?, ?, ?)`).run(gcodeFilename, gcodeFilename, amsSlot, reqMaterial, reqColor, now);
  return db;
}

const printerRow = db => db.prepare('SELECT * FROM printers WHERE id = 1').get();

describe('printerFilaments', () => {
  test('manual printer: one entry with its loaded material and color, no driver call', () => {
    const db = makeDb({ filamentAuto: 0 });
    expect(pf.printerFilaments(db, printerRow(db))).toEqual([{ material: 'PLA', color: 'Red', slot: null }]);
    expect(bambu.getLoadedFilament).not.toHaveBeenCalled();
  });

  test('filament_auto on a non-Bambu printer stays manual', () => {
    const db = makeDb({ type: 'prusa' });
    expect(pf.printerFilaments(db, printerRow(db))).toEqual([{ material: 'PLA', color: 'Red', slot: null }]);
  });

  test('Auto printer: each spool by product and type, colors named from the library', () => {
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    expect(pf.printerFilaments(db, printerRow(db))).toEqual([
      { material: 'ABS-GF', color: 'Black', slot: 0, nozzle: null },
      { material: 'PETG HF', color: 'Black', slot: 1, nozzle: null },
      { material: 'PETG', color: null, slot: 1, nozzle: null },      // library PETG has no colors with a hex
      { material: 'ABS-GF', color: null, slot: 2, nozzle: null },    // 0C3B95 is not near any ABS-GF color
      { material: 'PET-CF', color: null, slot: 3, nozzle: null },    // not in the library at all
    ]);
  });

  test('Auto printer before its first AMS report has no filament', () => {
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue(null);
    expect(pf.printerFilaments(db, printerRow(db))).toEqual([]);
  });

  test('a library color without a hex is never matched, and no far color is borrowed', () => {
    const db = makeDb({ blackHex: null });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const petgHf = pf.printerFilaments(db, printerRow(db)).find(f => f.material === 'PETG HF');
    expect(petgHf.color).toBeNull(); // black spool: White and Blue are both too far
  });

  test('nearest color within range wins: Bambu blue 002E96 is the library Blue', () => {
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue({ trays: [tray(2, 'PETG', 'PETG HF', '002E96')], external: null, active_slot: null });
    expect(pf.printerFilaments(db, printerRow(db))[0]).toEqual({ material: 'PETG HF', color: 'Blue', slot: 2, nozzle: null });
  });

  test('matchesRequirement and findSlot', () => {
    const set = [{ material: 'PETG HF', color: 'Black', slot: 1 }, { material: 'ABS-GF', color: 'Black', slot: 0 }];
    expect(pf.matchesRequirement(set, 'PETG HF', 'Black')).toBe(true);
    expect(pf.matchesRequirement(set, 'PETG HF', 'White')).toBe(false);
    expect(pf.matchesRequirement(set, null, null)).toBe(true);
    expect(pf.matchesRequirement([], 'PETG HF', null)).toBe(false);
    expect(pf.findSlot(set, 'ABS-GF', null)).toBe(0);
    expect(pf.findSlot(set, 'PLA', null)).toBeNull();
    expect(pf.findSlot(set, null, null)).toBeNull();
  });

  test('H2D: external holders join the set after the AMS, and findSlot keeps to the file nozzle', () => {
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue({
      trays: [{ ...tray(1, 'PETG', 'PETG HF', '000000'), nozzle: 0 }],
      externals: [
        { id: 255, nozzle: 0, type: null, name: null, color: null, remain: null },
        { id: 254, nozzle: 1, type: 'PETG', name: 'PETG HF', color: '000000', remain: null },
      ],
      external: null, active_slot: null,
    });
    const set = pf.printerFilaments(db, printerRow(db));
    expect(set.map(f => [f.slot, f.nozzle])).toEqual([[1, 0], [1, 0], [254, 1], [254, 1]]);
    expect(pf.findSlot(set, 'PETG HF', 'Black')).toBe(1);
    expect(pf.findSlot(set, 'PETG HF', 'Black', 0)).toBe(1);
    expect(pf.findSlot(set, 'PETG HF', 'Black', 1)).toBe(254);
    expect(pf.findSlot([{ material: 'PLA', color: null, slot: 0, nozzle: 0 }], 'PLA', null, 1)).toBeNull();
  });
});

describe('dispatch with Auto filament', () => {
  test('matches through the AMS and prints from the matching slot, not the G-code slot', async () => {
    const db = makeDb({ amsSlot: 3 });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });

    const jobId = await scheduler._dispatchToPrinter(printerRow(db));

    expect(jobId).not.toBeNull();
    expect(mockDriver.uploadAndPrint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }), expect.any(String), gcodeFilename, { amsSlot: 1 });
  });

  test('ignores the manual Material/Color fields while Auto is on', async () => {
    // Manual fields say PLA / Red, which would never match a PETG HF part.
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    expect(await scheduler._dispatchToPrinter(printerRow(db))).not.toBeNull();
  });

  test('no dispatch when no spool has the required color', async () => {
    const db = makeDb({ reqColor: 'White' });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    expect(await scheduler._dispatchToPrinter(printerRow(db))).toBeNull();
    expect(mockDriver.uploadAndPrint).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });

  test('no dispatch for a filament part before the AMS has reported', async () => {
    const db = makeDb();
    bambu.getLoadedFilament.mockReturnValue(null);
    const scheduler = new JobScheduler(db, { on: () => {} });
    expect(await scheduler._dispatchToPrinter(printerRow(db))).toBeNull();
  });

  test('a part with no requirement keeps the G-code slot', async () => {
    const db = makeDb({ reqMaterial: null, reqColor: null, amsSlot: 3 });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    await scheduler._dispatchToPrinter(printerRow(db));
    expect(mockDriver.uploadAndPrint.mock.calls[0][3]).toEqual({ amsSlot: 3 });
  });

  test('a match-from-AMS G-code on an Auto printer prints from the slot that matched', async () => {
    const db = makeDb({ amsSlot: -2 });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    await scheduler._dispatchToPrinter(printerRow(db));
    expect(mockDriver.uploadAndPrint.mock.calls[0][3]).toEqual({ amsSlot: 1 });
  });

  test('a match-from-AMS G-code with no requirement is left for the driver to match by file', async () => {
    const db = makeDb({ amsSlot: -2, reqMaterial: null, reqColor: null });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    await scheduler._dispatchToPrinter(printerRow(db));
    expect(mockDriver.uploadAndPrint.mock.calls[0][3]).toEqual({ amsSlot: -2 });
  });

  test('manual printers still match on the typed-in values only', async () => {
    const db = makeDb({ filamentAuto: 0 });
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    const scheduler = new JobScheduler(db, { on: () => {} });
    expect(await scheduler._dispatchToPrinter(printerRow(db))).toBeNull(); // PLA / Red loaded
  });
});

describe('re-check when the AMS changes', () => {
  test('first sighting only records; a later change dispatches an idle Auto printer', () => {
    const db = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    const spy = jest.spyOn(scheduler, 'scheduleForPrinter').mockImplementation(() => {});

    bambu.getLoadedFilament.mockReturnValue({ trays: [tray(0, 'ABS-GF', 'ABS-GF', '000000')], external: null, active_slot: null });
    scheduler._recheckAutoFilamentPrinters();
    scheduler._recheckAutoFilamentPrinters();
    expect(spy).not.toHaveBeenCalled();

    bambu.getLoadedFilament.mockReturnValue(H2S_004); // operator loads PETG HF
    scheduler._recheckAutoFilamentPrinters();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ id: 1, name: 'BL-H2S-004' });
  });

  test('a held or printing printer is not dispatched on an AMS change', () => {
    const db = makeDb();
    const scheduler = new JobScheduler(db, { on: () => {} });
    const spy = jest.spyOn(scheduler, 'scheduleForPrinter').mockImplementation(() => {});

    bambu.getLoadedFilament.mockReturnValue({ trays: [], external: null, active_slot: null });
    scheduler._recheckAutoFilamentPrinters();
    db.prepare("UPDATE printers SET status = 'PRINTING'").run();
    bambu.getLoadedFilament.mockReturnValue(H2S_004);
    scheduler._recheckAutoFilamentPrinters();

    db.prepare("UPDATE printers SET status = 'IDLE', is_held = 1").run();
    bambu.getLoadedFilament.mockReturnValue({ trays: [], external: null, active_slot: null });
    scheduler._recheckAutoFilamentPrinters();
    expect(spy).not.toHaveBeenCalled();
  });
});
