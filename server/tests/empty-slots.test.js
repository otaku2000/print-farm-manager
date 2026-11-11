// Tests for server/empty-slots.js: reminders for AMS slots that run empty.

const Database = require('better-sqlite3');
const notifications = require('../notifications');
const emptySlots = require('../empty-slots');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, type TEXT, is_active INTEGER)`);
  db.prepare("INSERT INTO printers VALUES (1, 'BL-H2S-010', 'bambu', 1), (2, 'MK4_01', 'prusa', 1)").run();
  emptySlots.reset();
  for (const n of notifications.list()) notifications.dismiss(n.id);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => { db.close(); console.warn.mockRestore(); });

const report = (...types) => ({ trays: types.map((type, slot) => ({ slot, type })) });

function run(...reports) {
  const get = jest.fn();
  for (const r of reports) get.mockReturnValueOnce(r);
  for (let i = 0; i < reports.length; i++) emptySlots.check(db, get);
  return get;
}

test('the first report only records: slots already empty never raise a reminder', () => {
  run(report('ABS-GF', null, null, 'PETG'));
  expect(emptySlots.list()).toEqual({});
  expect(notifications.list()).toHaveLength(0);
});

test('a slot that runs empty raises one reminder and one notification', () => {
  run(report('ABS-GF', 'PETG'), report('ABS-GF', null), report('ABS-GF', null));
  expect(emptySlots.list()).toEqual({ 1: [{ slot: 1, was: 'PETG', since: expect.any(Number) }] });
  const notes = notifications.list();
  expect(notes).toHaveLength(1);
  expect(notes[0].message).toBe('BL-H2S-010: AMS slot 2 is empty (was PETG). Load a new spool.');
});

test('loading a spool clears the reminder and its notification', () => {
  run(report('ABS-GF', 'PETG'), report('ABS-GF', null), report('ABS-GF', 'PETG'));
  expect(emptySlots.list()).toEqual({});
  expect(notifications.list()).toHaveLength(0);
});

test('a slot on a second AMS is named by its compound slot', () => {
  run({ trays: [{ slot: 5, type: 'PLA' }] }, { trays: [{ slot: 5, type: null }] });
  expect(notifications.list()[0].message).toMatch(/AMS slot 6 is empty/);
});

test('a printer with no AMS report yet is skipped, and the next report is its baseline', () => {
  run(null, report('PETG', null));
  expect(emptySlots.list()).toEqual({});
});

test('a decommissioned printer loses its reminders', () => {
  run(report('PETG'), report(null));
  expect(Object.keys(emptySlots.list())).toEqual(['1']);
  db.prepare('UPDATE printers SET is_active = 0 WHERE id = 1').run();
  emptySlots.check(db, jest.fn());
  expect(emptySlots.list()).toEqual({});
  expect(notifications.list()).toHaveLength(0);
});

test('a driver error for one printer does not stop the check', () => {
  const get = jest.fn(() => { throw new Error('boom'); });
  expect(() => emptySlots.check(db, get)).not.toThrow();
});

test('non-Bambu printers are never asked', () => {
  const get = run(report('PETG'));
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][0].name).toBe('BL-H2S-010');
});
