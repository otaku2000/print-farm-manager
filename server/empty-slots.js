// Reminders to reload an AMS slot that ran empty.
//
// After every poll, each active Bambu printer's live AMS report (the driver's cached MQTT
// report, so no printer is contacted) is compared with the last one seen. A tray that held
// a spool and now reports none gets a reminder: a notification in Settings and a "Load
// Spool" tag on its Fleet card. Loading a spool into that slot clears both.
//
// Only a change seen while the server runs creates a reminder. The first report after a
// start only records what is loaded, so a slot left empty on purpose (a printer run with
// two spools) never nags, and a restart does not re-raise every empty slot on the farm.
// Like notifications, reminders live in memory and are gone after a restart.

const notifications = require('./notifications');

const seen = new Map();      // printer id -> Map(slot -> type or null)
const reminders = new Map(); // printer id -> Map(slot -> { slot, was, since, noteId })

function slotLabel(slot) {
  return `slot ${slot + 1}`;
}

// getLoadedFilament is the Bambu driver's (passed in so tests can stub it).
function check(db, getLoadedFilament) {
  const rows = db.prepare("SELECT * FROM printers WHERE is_active = 1 AND type = 'bambu'").all();
  const live = new Set();
  for (const row of rows) {
    live.add(row.id);
    let loaded = null;
    try { loaded = getLoadedFilament(row); } catch (_) {}
    if (!loaded) continue;

    const previous = seen.get(row.id);
    const current = new Map(loaded.trays.map(t => [t.slot, t.type || null]));
    seen.set(row.id, current);
    if (!previous) continue;

    let open = reminders.get(row.id);
    for (const [slot, type] of current) {
      const was = previous.get(slot);
      if (type) {
        const reminder = open?.get(slot);
        if (reminder) {
          notifications.dismiss(reminder.noteId);
          open.delete(slot);
        }
      } else if (was && !open?.has(slot)) {
        const note = notifications.add(`${row.name}: AMS ${slotLabel(slot)} is empty (was ${was}). Load a new spool.`);
        if (!open) { open = new Map(); reminders.set(row.id, open); }
        open.set(slot, { slot, was, since: Date.now(), noteId: note.id });
      }
    }
    if (open && open.size === 0) reminders.delete(row.id);
  }
  // Decommissioned or deleted printers: forget them and drop their reminders.
  for (const id of [...seen.keys()]) {
    if (live.has(id)) continue;
    seen.delete(id);
    for (const r of reminders.get(id)?.values() || []) notifications.dismiss(r.noteId);
    reminders.delete(id);
  }
}

// Open reminders keyed by printer id: { "5": [{ slot, was, since }] }.
function list() {
  const out = {};
  for (const [id, open] of reminders) {
    out[id] = [...open.values()]
      .sort((a, b) => a.slot - b.slot)
      .map(({ slot, was, since }) => ({ slot, was, since }));
  }
  return out;
}

function reset() {
  seen.clear();
  reminders.clear();
}

module.exports = { check, list, reset };
