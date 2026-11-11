// Tests for GET /api/printers/lookup-serial and GET /api/printers/empty-slots

jest.mock('../drivers/bambu', () => ({ lookupSerial: jest.fn(), getLoadedFilament: jest.fn(), getNozzles: jest.fn(() => null) }));
jest.mock('../events', () => ({ insert: jest.fn() }));

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const bambu    = require('../drivers/bambu');
const emptySlots = require('../empty-slots');

let db;
let app;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, ip TEXT NOT NULL,
      type TEXT DEFAULT 'prusa', model TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO printers (name, ip, type, model, created_at) VALUES ('BL-H2S-010', '10.0.0.10', 'bambu', 'h2s', 1)").run();
  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

afterAll(() => db.close());
afterEach(() => { bambu.lookupSerial.mockReset(); emptySlots.reset(); });

describe('GET /api/printers/lookup-serial', () => {
  test('returns the serial the printer reports', async () => {
    bambu.lookupSerial.mockResolvedValue('0938AJ611400475');
    const res = await request(app).get('/api/printers/lookup-serial?type=bambu&ip=192.168.0.103');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serial: '0938AJ611400475' });
    expect(bambu.lookupSerial).toHaveBeenCalledWith('192.168.0.103');
  });

  test('defaults to Bambu when no type is given', async () => {
    bambu.lookupSerial.mockResolvedValue('0948AD5B2001764');
    const res = await request(app).get('/api/printers/lookup-serial?ip=192.168.0.205');
    expect(res.body.serial).toBe('0948AD5B2001764');
  });

  test('404 when nothing answers as a Bambu printer', async () => {
    bambu.lookupSerial.mockResolvedValue(null);
    const res = await request(app).get('/api/printers/lookup-serial?type=bambu&ip=192.168.0.250');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/192\.168\.0\.250/);
  });

  test('400 for a missing or invalid IP, never contacting anything', async () => {
    for (const q of ['', '?ip=', '?ip=printer.local', '?ip=192.168.0']) {
      const res = await request(app).get(`/api/printers/lookup-serial${q}`);
      expect(res.status).toBe(400);
    }
    expect(bambu.lookupSerial).not.toHaveBeenCalled();
  });

  test('400 for a brand without serial lookup', async () => {
    const res = await request(app).get('/api/printers/lookup-serial?type=elegoo-centauri2&ip=192.168.0.20');
    expect(res.status).toBe(400);
    expect(bambu.lookupSerial).not.toHaveBeenCalled();
  });

  test('is not shadowed by /:id', async () => {
    bambu.lookupSerial.mockResolvedValue('X1');
    const res = await request(app).get('/api/printers/lookup-serial?ip=10.0.0.1');
    expect(res.body).not.toHaveProperty('error', 'Printer not found');
  });
});

describe('GET /api/printers/empty-slots', () => {
  test('lists open reminders keyed by printer id', async () => {
    const trays = (types) => ({ trays: types.map((type, slot) => ({ slot, type })) });
    const get = jest.fn().mockReturnValueOnce(trays(['PETG', 'PETG'])).mockReturnValueOnce(trays(['PETG', null]));
    emptySlots.check(db, get);
    emptySlots.check(db, get);
    const res = await request(app).get('/api/printers/empty-slots');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 1: [{ slot: 1, was: 'PETG', since: expect.any(Number) }] });
  });

  test('empty object when nothing ran out', async () => {
    const res = await request(app).get('/api/printers/empty-slots');
    expect(res.body).toEqual({});
  });
});
