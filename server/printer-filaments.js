// What filament a printer can print with right now, as a list of
// { material, color, slot } entries. This is what the dispatch candidate query matches a
// part's required material and color against (server/candidate-query.js).
//
// A printer in manual mode (filament_auto = 0) has exactly one entry, the operator-set
// loaded_material and loaded_color, with no slot. That single entry reproduces the old
// equality check exactly: a requirement matches when the entry's value equals it.
//
// A Bambu printer in Auto mode (filament_auto = 1) has one entry per loaded AMS tray, read
// live from the driver's cached MQTT report, so a part matches when ANY loaded spool has
// its material and color. Each tray is named twice: by its product (tray_sub_brands, such
// as "PETG HF") and by its generic type ("PETG"), so a requirement written either way
// matches. Its color is the nearest color in the filament library for that material,
// measured against the tray's hex. A library color with no hex cannot be matched, and a
// tray further than MAX_COLOR_DISTANCE from every library color gets no color, so a
// White spool is never called "Black" just because Black is the only color with a hex.
// Until the printer reports its AMS, an Auto printer has no entries and only matches
// parts with no filament requirement.
//
// Callers: the scheduler (dispatch and the AMS-change re-check), the schedule projection,
// the dispatch-status and queue diagnostics (routes/parts.js), and the schedule
// fingerprint. They all build the set here, so they cannot disagree.

// RGB distance (0 to 441) beyond which a tray is not called any library color. Must exceed
// the gap between a real spool and the library's approximation of its color (Bambu blue
// 002E96 against a library Blue of 0000FF is about 115), and stay well below the gap
// between colors that should never be confused (black to white is 441, black to pure
// blue 255).
const MAX_COLOR_DISTANCE = 150;

function isAuto(printer) {
  return printer.type === 'bambu' && printer.filament_auto === 1;
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// Library lookups, read once per call to printerFilaments.
function loadLibrary(db) {
  const types = db.prepare('SELECT id, name FROM filament_types').all();
  const colors = db.prepare('SELECT type_id, name, hex_color FROM filament_colors').all();
  return { types, colors };
}

// The library's spelling of a material name (matched case-insensitively), or the name as
// the printer reported it when the library does not have it.
function canonicalMaterial(library, name) {
  const t = library.types.find(x => x.name.toLowerCase() === name.toLowerCase());
  return t || { id: null, name };
}

function nearestColor(library, typeId, trayHex) {
  const rgb = parseHex(trayHex);
  if (typeId == null || !rgb) return null;
  let best = null;
  for (const c of library.colors) {
    if (c.type_id !== typeId) continue;
    const lib = parseHex(c.hex_color);
    if (!lib) continue;
    const d = distance(rgb, lib);
    if (d <= MAX_COLOR_DISTANCE && (!best || d < best.d)) best = { name: c.name, d };
  }
  return best ? best.name : null;
}

// The filament set for one printer row. The row must carry type, filament_auto,
// loaded_material and loaded_color (SELECT * does).
function printerFilaments(db, printer) {
  if (!isAuto(printer)) {
    return [{ material: printer.loaded_material ?? null, color: printer.loaded_color ?? null, slot: null }];
  }
  const loaded = require('./drivers/bambu').getLoadedFilament(printer);
  if (!loaded) return [];

  const library = loadLibrary(db);
  const out = [];
  for (const tray of loaded.trays) {
    if (!tray.type) continue;
    const names = [...new Set([tray.name, tray.type].filter(Boolean))];
    for (const name of names) {
      const material = canonicalMaterial(library, name);
      out.push({ material: material.name, color: nearestColor(library, material.id, tray.color), slot: tray.slot });
    }
  }
  return out;
}

// The bind value for the candidate query's json_each(?).
function filamentsParam(db, printer) {
  return JSON.stringify(printerFilaments(db, printer));
}

// JS mirror of the candidate query's filament predicate (routes/parts.js uses it).
function matchesRequirement(filaments, requiredMaterial, requiredColor) {
  if (!requiredMaterial && !requiredColor) return true;
  return filaments.some(f =>
    (!requiredMaterial || f.material === requiredMaterial) &&
    (!requiredColor || f.color === requiredColor));
}

// The AMS slot holding a spool that meets the requirement, or null (manual printers, no
// requirement, or no match).
function findSlot(filaments, requiredMaterial, requiredColor) {
  if (!requiredMaterial && !requiredColor) return null;
  const hit = filaments.find(f => f.slot != null &&
    (!requiredMaterial || f.material === requiredMaterial) &&
    (!requiredColor || f.color === requiredColor));
  return hit ? hit.slot : null;
}

// What an operator sees for a printer's filament: the manual values, or the loaded AMS
// spools summarized for an Auto printer.
function describeFilaments(printer, filaments) {
  if (!isAuto(printer)) return [printer.loaded_material, printer.loaded_color].filter(Boolean).join(' / ');
  const seen = new Set();
  const parts = [];
  for (const f of filaments) {
    const label = [f.material, f.color].filter(Boolean).join(' ');
    if (!seen.has(f.slot)) { seen.add(f.slot); parts.push(label); }
  }
  return parts.length ? `Auto: ${parts.join(', ')}` : 'Auto: AMS not reported';
}

module.exports = {
  isAuto, printerFilaments, filamentsParam, matchesRequirement, findSlot, describeFilaments,
  MAX_COLOR_DISTANCE,
};
