// Tests for GET /api/printers/loaded-filament, GET /api/printers/:id/loaded-filament,
// and the filament_auto field on PUT /api/printers/:id

jest.mock('../drivers/bambu', () => ({ getLoadedFilament: jest.fn() }));
jest.mock('../events', () => ({ insert: jest.fn() }));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const bambu    = require('../drivers/bambu');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      ip         TEXT NOT NULL,
      api_key    TEXT NOT NULL DEFAULT '',
      type       TEXT DEFAULT 'prusa',
      model      TEXT NOT NULL,
      is_active  INTEGER DEFAULT 1,
      serial_number TEXT DEFAULT '',
      group_name TEXT,
      is_held    INTEGER DEFAULT 0,
      decommission_note TEXT,
      loaded_material TEXT,
      loaded_color TEXT,
      filament_auto INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    INSERT INTO printer_models VALUES ('h2s', 'H2S', 'bambu'), ('mk4', 'MK4', 'prusa');
  `);
  const insert = db.prepare('INSERT INTO printers (name, ip, type, model, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('BL-H2S-003', '10.0.0.3', 'bambu', 'h2s', 1, Date.now());
  insert.run('BL-H2S-004', '10.0.0.4', 'bambu', 'h2s', 1, Date.now());
  insert.run('MK4_01', '10.0.0.5', 'prusa', 'mk4', 1, Date.now());
  insert.run('BL-OLD', '10.0.0.6', 'bambu', 'h2s', 0, Date.now());

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

afterAll(() => db.close());

afterEach(() => bambu.getLoadedFilament.mockReset());

const SAMPLE = {
  trays: [
    { slot: 0, ams_id: 0, slot_id: 0, type: 'ABS-GF', color: '000000' },
    { slot: 1, ams_id: 0, slot_id: 1, type: null, color: null },
  ],
  external: null,
  active_slot: 0,
};

test('returns live filament for active Bambu printers, keyed by printer id', async () => {
  bambu.getLoadedFilament.mockImplementation(p => (p.name === 'BL-H2S-003' ? SAMPLE : null));

  const res = await request(app).get('/api/printers/loaded-filament');

  expect(res.status).toBe(200);
  const id = db.prepare("SELECT id FROM printers WHERE name = 'BL-H2S-003'").get().id;
  expect(res.body).toEqual({ [id]: SAMPLE });
});

test('asks the driver only about active Bambu printers', async () => {
  bambu.getLoadedFilament.mockReturnValue(null);

  await request(app).get('/api/printers/loaded-filament');

  const asked = bambu.getLoadedFilament.mock.calls.map(c => c[0].name).sort();
  expect(asked).toEqual(['BL-H2S-003', 'BL-H2S-004']);
});

describe('GET /api/printers/:id/loaded-filament', () => {
  const idOf = name => db.prepare('SELECT id FROM printers WHERE name = ?').get(name).id;

  test('returns the live filament for a Bambu printer', async () => {
    bambu.getLoadedFilament.mockReturnValue(SAMPLE);
    const res = await request(app).get(`/api/printers/${idOf('BL-H2S-003')}/loaded-filament`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ filament: SAMPLE });
  });

  test('null for a Bambu printer that has not reported', async () => {
    bambu.getLoadedFilament.mockReturnValue(null);
    const res = await request(app).get(`/api/printers/${idOf('BL-H2S-004')}/loaded-filament`);
    expect(res.body).toEqual({ filament: null });
  });

  test('null without asking the driver for a non-Bambu or decommissioned printer', async () => {
    for (const name of ['MK4_01', 'BL-OLD']) {
      const res = await request(app).get(`/api/printers/${idOf(name)}/loaded-filament`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ filament: null });
    }
    expect(bambu.getLoadedFilament).not.toHaveBeenCalled();
  });

  test('404 for an unknown printer', async () => {
    const res = await request(app).get('/api/printers/9999/loaded-filament');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Printer not found' });
  });
});

describe('PUT /api/printers/:id filament_auto', () => {
  const events = require('../events');
  const idOf = name => db.prepare('SELECT id FROM printers WHERE name = ?').get(name).id;
  const autoOf = name => db.prepare('SELECT filament_auto FROM printers WHERE name = ?').get(name).filament_auto;

  test('turns Auto on for a Bambu printer and logs the change', async () => {
    const res = await request(app).put(`/api/printers/${idOf('BL-H2S-003')}`).send({ filament_auto: 1 });
    expect(res.status).toBe(200);
    expect(res.body.filament_auto).toBe(1);
    expect(events.insert).toHaveBeenCalledWith(idOf('BL-H2S-003'), 'info_changed', 'Filament source: Auto (from AMS)');
  });

  test('accepts booleans and turns Auto off again', async () => {
    await request(app).put(`/api/printers/${idOf('BL-H2S-003')}`).send({ filament_auto: true });
    expect(autoOf('BL-H2S-003')).toBe(1);
    await request(app).put(`/api/printers/${idOf('BL-H2S-003')}`).send({ filament_auto: false });
    expect(autoOf('BL-H2S-003')).toBe(0);
  });

  test('400 for a non-Bambu printer', async () => {
    const res = await request(app).put(`/api/printers/${idOf('MK4_01')}`).send({ filament_auto: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only available for Bambu/);
    expect(autoOf('MK4_01')).toBe(0);
  });

  test('400 for a value other than 0/1/true/false', async () => {
    const res = await request(app).put(`/api/printers/${idOf('BL-H2S-004')}`).send({ filament_auto: 'yes' });
    expect(res.status).toBe(400);
    expect(autoOf('BL-H2S-004')).toBe(0);
  });

  test('omitting filament_auto leaves it unchanged', async () => {
    await request(app).put(`/api/printers/${idOf('BL-H2S-004')}`).send({ filament_auto: 1 });
    await request(app).put(`/api/printers/${idOf('BL-H2S-004')}`).send({ group_name: 'Rack A' });
    expect(autoOf('BL-H2S-004')).toBe(1);
  });
});

describe('POST /api/printers filament_auto', () => {
  const bambuBody = name => ({ name, ip: '10.0.0.9', api_key: 'code', serial_number: 'SN1', type: 'bambu', model: 'h2s' });

  test('creates a Bambu printer in Auto mode', async () => {
    const res = await request(app).post('/api/printers').send({ ...bambuBody('BL-NEW-1'), filament_auto: 1 });
    expect(res.status).toBe(201);
    expect(res.body.filament_auto).toBe(1);
  });

  test('defaults to manual when omitted', async () => {
    const res = await request(app).post('/api/printers').send({ ...bambuBody('BL-NEW-2'), loaded_material: 'PETG HF' });
    expect(res.status).toBe(201);
    expect(res.body.filament_auto).toBe(0);
    expect(res.body.loaded_material).toBe('PETG HF');
  });

  test('400 and nothing created for a non-Bambu printer or a bad value', async () => {
    const prusa = await request(app).post('/api/printers')
      .send({ name: 'MK4_NEW', ip: '10.0.0.10', api_key: 'k', type: 'prusa', model: 'mk4', filament_auto: 1 });
    expect(prusa.status).toBe(400);
    expect(prusa.body.error).toMatch(/only available for Bambu/);
    const bad = await request(app).post('/api/printers').send({ ...bambuBody('BL-NEW-3'), filament_auto: 'on' });
    expect(bad.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM printers WHERE name IN ('MK4_NEW', 'BL-NEW-3')").get().n).toBe(0);
  });
});

test('is not shadowed by GET /:id', async () => {
  bambu.getLoadedFilament.mockReturnValue(null);
  const res = await request(app).get('/api/printers/loaded-filament');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({});
});
