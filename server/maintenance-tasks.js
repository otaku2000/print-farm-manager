// Maintenance tasks: the separate jobs a printer needs (clean the build plate, lubricate the
// rods, replace filters, ...), each with its own interval in days and/or print hours. The
// list is farm-wide and editable from the Maintenance page.
//
// The log (printer_maintenance) records each job done. A row with task_id NULL is a full
// service: it counts as every task done that day. That is also what every log entry written
// before tasks existed means, so existing history keeps its meaning without rewriting rows.
//
// Default intervals are general FDM guidance, not a printer maker's schedule: adjust them to
// the farm's printers and materials on the Maintenance page.

const DEFAULT_TASKS = [
  { name: 'Clean the build plate',                      days: 7,   hours: 100,  description: 'Wash with dish soap and warm water, or wipe with isopropyl alcohol, to remove skin oils and residue.' },
  { name: 'Clean the nozzle and check for clogs',       days: 30,  hours: 200,  description: 'Wipe off plastic build-up while hot, check extrusion is even, and do a cold pull if it is partly clogged.' },
  { name: 'Clean the purge chute and nozzle wiper',     days: 14,  hours: 100,  description: 'Empty the waste chute and clear purged filament from the wiper and purge area.' },
  { name: 'Clean and lube the rods',                    days: 90,  hours: 500,  description: 'Wipe the motion rods or rails clean, then apply the lubricant the printer maker specifies.' },
  { name: 'Clean and grease the lead screws',           days: 90,  hours: 1000, description: 'Clean old grease and dust off the Z lead screws, then apply fresh grease.' },
  { name: 'Replace the filters',                        days: 90,  hours: 1000, description: 'Replace the activated carbon and particulate filters.' },
  { name: 'Check belt tension',                         days: 90,  hours: 1000, description: 'Check the belts for wear and correct tension; run the printer calibration afterwards if adjusted.' },
  { name: 'Clean the extruder gears and filament path', days: 60,  hours: 500,  description: 'Brush plastic dust out of the drive gears, check PTFE tubes and the filament cutter.' },
  { name: 'Clean the AMS and replace desiccant',        days: 30,  hours: null, description: 'Clear dust from the AMS feeders and replace or dry the desiccant.' },
  { name: 'Clean the fans and heatsinks',               days: 90,  hours: 1000, description: 'Blow out dust from the part cooling fan, hotend fan, and heatsink fins.' },
  { name: 'Inspect the hotend and nozzle for wear',     days: 180, hours: 2000, description: 'Check the nozzle tip for wear and the hotend for leaks; replace the nozzle if worn.' },
  { name: 'Tighten screws and inspect wiring',          days: 180, hours: 2000, description: 'Check frame screws, the print head, and cables for looseness, chafing, or damage.' },
];

// Creates the tasks table and the log's task_id column, and seeds the defaults once. Seeding
// is remembered in settings, so deleting a default task does not bring it back.
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    description    TEXT,
    interval_days  INTEGER,
    interval_hours INTEGER,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL
  )`);
  try { db.exec('ALTER TABLE printer_maintenance ADD COLUMN task_id INTEGER'); } catch (_) {}

  const seeded = db.prepare("SELECT 1 FROM settings WHERE key = 'maintenance_tasks_seeded'").get();
  if (seeded) return;
  db.transaction(() => {
    if (db.prepare('SELECT COUNT(*) AS n FROM maintenance_tasks').get().n === 0) {
      const insert = db.prepare(`
        INSERT INTO maintenance_tasks (name, description, interval_days, interval_hours, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      DEFAULT_TASKS.forEach((t, i) => insert.run(t.name, t.description, t.days, t.hours, i, now));
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance_tasks_seeded', '1')").run();
  })();
}

module.exports = { ensureSchema, DEFAULT_TASKS };
