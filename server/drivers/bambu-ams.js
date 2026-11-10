// Builds the AMS mapping a Bambu project_file command carries, from the sliced file itself
// and the printer's live AMS report.
//
// Array layout follows Bambu Studio's own sender, read from bambulab/BambuStudio
// src/slic3r/GUI/SelectMachine.cpp (SelectMachineDialog::get_ams_mapping_result):
//   ams_mapping   one entry per project filament, index = filament id - 1, value = tray id
//                 (ams_id * 4 + slot_id, DeviceManager.cpp get_tray_id_by_ams_id_and_slot_id),
//                 -1 for a filament the plate does not use.
//   ams_mapping2  same indexes, each { ams_id, slot_id }, 255/255 for an unused filament.
// Filament ids are 1-based in Metadata/slice_info.config (SelectMachine.cpp converts with
// "used_filaments[i] - 1"). The project filament count is the length of the per-filament
// arrays in Metadata/project_settings.config.
//
// Why the farm needs this: a plate that prints with filament 2 got [slot], which maps
// filament 1 and leaves filament 2 unmapped, and the printer paused with "Failed to get AMS
// mapping table". The slot a G-code was configured with is also chosen once per printer
// model, so it can point at a different filament on a printer loaded differently.

const fs  = require('fs');
const zip = require('../zip-reader');

const SLICE_INFO_ENTRY       = 'Metadata/slice_info.config';
const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config';
const UNUSED_TRAY = -1;
const UNUSED_AMS_ID = 255;
const SLOTS_PER_AMS = 4;
// gcodes.ams_slot value meaning "no fixed slot: match one from the AMS at dispatch".
// -1 is already the external spool and 0 and up are fixed trays.
const AMS_SLOT_MATCH = -2;

// The farm always prints plate 1 (see uploadAndPrint in bambu.js).
function plateOneBlock(xml) {
  const blocks = xml.match(/<plate\b[\s\S]*?<\/plate>/gi);
  if (!blocks || blocks.length === 0) return null;
  const plateOne = blocks.find(b => /key\s*=\s*"index"\s+value\s*=\s*"1"/i.test(b));
  if (plateOne) return plateOne;
  return blocks.length === 1 ? blocks[0] : null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

// Returns { filamentCount, used: [{ index, type, color }] } for plate 1, or null when the
// file does not say (not a sliced .3mf, or a slicer that wrote no filament list).
// color is RRGGBB uppercase without '#', or null.
function readPlateFilaments(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }

  const sliceInfo = zip.readEntry(buf, SLICE_INFO_ENTRY);
  if (!sliceInfo) return null;
  const plate = plateOneBlock(sliceInfo.toString('utf8'));
  if (!plate) return null;

  const used = [];
  for (const tag of plate.match(/<filament\b[^>]*>/gi) || []) {
    const id = parseInt(attr(tag, 'id'), 10);
    if (!Number.isInteger(id) || id < 1) continue;
    const color = (attr(tag, 'color') || '').replace(/^#/, '').toUpperCase();
    used.push({ index: id - 1, type: attr(tag, 'type') || '', color: /^[0-9A-F]{6}$/.test(color) ? color : null });
  }
  if (used.length === 0) return null;

  let filamentCount = 0;
  const settings = zip.readEntry(buf, PROJECT_SETTINGS_ENTRY);
  if (settings) {
    try {
      const types = JSON.parse(settings.toString('utf8')).filament_type;
      if (Array.isArray(types)) filamentCount = types.length;
    } catch (_) {}
  }
  // A file without project settings still needs room for every filament the plate uses.
  filamentCount = Math.max(filamentCount, ...used.map(f => f.index + 1));

  return { filamentCount, used };
}

// Flattens the printer's live AMS report into trays: { tray, amsId, slotId, type, color }.
// Returns null when no AMS report has arrived yet.
function liveTrays(latestPrint) {
  const units = latestPrint?.ams?.ams;
  if (!Array.isArray(units)) return null;
  const trays = [];
  for (const unit of units) {
    const amsId = parseInt(unit.id, 10);
    if (!Number.isInteger(amsId)) continue;
    for (const t of unit.tray || []) {
      const slotId = parseInt(t.id, 10);
      if (!Number.isInteger(slotId)) continue;
      trays.push({
        tray: amsId * SLOTS_PER_AMS + slotId,
        amsId,
        slotId,
        type: t.tray_type || '',
        subBrand: t.tray_sub_brands || '',
        color: t.tray_color ? String(t.tray_color).slice(0, 6).toUpperCase() : null,
        remain: typeof t.remain === 'number' ? t.remain : null,
      });
    }
  }
  return trays;
}

function sameType(a, b) {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

// Picks the tray for the plate's filament. With a configured slot (a number), keeps it only
// when the printer's report shows the needed filament type in it; otherwise moves to a tray
// holding that type, preferring the same color. With configuredTray null (match from AMS),
// goes straight to that search. Never guesses: with no AMS report, or no tray of the type
// (an empty tray reports no tray_type), it throws.
function chooseTray(printerName, filament, configuredTray, trays) {
  if (!trays) {
    const err = new Error(`${printerName} has not reported its AMS contents yet, so the filament slot cannot be checked`);
    err.code = 'AMS_UNKNOWN';
    throw err;
  }
  const matching = configuredTray == null;
  if (!filament.type) {
    if (matching) {
      const err = new Error('the sliced file names no filament type, so no AMS slot can be matched; give the G-code a fixed slot');
      err.code = 'AMS_NO_FILE_INFO';
      throw err;
    }
    // A file that names no type gives nothing to check against: use the configured slot.
    return { tray: configuredTray, amsId: Math.floor(configuredTray / SLOTS_PER_AMS), slotId: configuredTray % SLOTS_PER_AMS, note: null };
  }

  let held = null;
  if (!matching) {
    const current = trays.find(t => t.tray === configuredTray);
    if (current && current.type && sameType(current.type, filament.type)) {
      return { tray: configuredTray, amsId: Math.floor(configuredTray / SLOTS_PER_AMS), slotId: configuredTray % SLOTS_PER_AMS, note: null };
    }
    held = current && current.type ? current.type : 'nothing';
  }

  const matches = trays.filter(t => t.type && sameType(t.type, filament.type));
  if (matches.length === 0) {
    const loaded = trays.filter(t => t.type).map(t => `slot ${t.tray + 1} ${t.type}`).join(', ') || 'nothing';
    const err = new Error(matching
      ? `${printerName} has no ${filament.type} in its AMS (loaded: ${loaded})`
      : `${printerName} has no ${filament.type} in its AMS (configured slot ${configuredTray + 1} holds ${held}; loaded: ${loaded})`);
    err.code = 'AMS_NO_MATCH';
    throw err;
  }
  const pick = matches.find(t => filament.color && t.color === filament.color) || matches[0];
  return {
    ...pick,
    note: matching
      ? `matched slot ${pick.tray + 1} (${pick.type}${pick.color ? ` #${pick.color}` : ''}) from the AMS`
      : `configured slot ${configuredTray + 1} holds ${held}, using slot ${pick.tray + 1} (${pick.type}) instead`,
  };
}

// Returns { useAms, amsMapping, amsMapping2, note } for the project_file payload.
// amsSlot is the G-code's configured slot: -1 or null means the external spool, 0 to N a
// fixed tray, and AMS_SLOT_MATCH (-2) means pick the tray from the AMS by the sliced
// file's filament type and color.
function buildAmsMapping({ printerName, amsSlot, plate, latestPrint }) {
  const matching = amsSlot === AMS_SLOT_MATCH;
  if (!matching && (amsSlot == null || amsSlot < 0)) {
    return { useAms: false, amsMapping: [], amsMapping2: null, note: null };
  }
  if (!plate) {
    if (matching) {
      const err = new Error('the sliced file does not list its filament, so no AMS slot can be matched; give the G-code a fixed slot');
      err.code = 'AMS_NO_FILE_INFO';
      throw err;
    }
    // Without the file's filament list there is nothing to index by: send the slot as before.
    return { useAms: true, amsMapping: [amsSlot], amsMapping2: null, note: null };
  }
  if (plate.used.length > 1) {
    const err = new Error(
      `plate 1 uses ${plate.used.length} filaments; the farm maps one AMS slot per G-code, so multi-filament plates are not supported`
    );
    err.code = 'AMS_MULTI_FILAMENT';
    throw err;
  }

  const filament = plate.used[0];
  const chosen = chooseTray(printerName, filament, matching ? null : amsSlot, liveTrays(latestPrint));

  const amsMapping  = Array(plate.filamentCount).fill(UNUSED_TRAY);
  const amsMapping2 = Array.from({ length: plate.filamentCount }, () => ({ ams_id: UNUSED_AMS_ID, slot_id: UNUSED_AMS_ID }));
  amsMapping[filament.index]  = chosen.tray;
  amsMapping2[filament.index] = { ams_id: chosen.amsId, slot_id: chosen.slotId };

  return { useAms: true, amsMapping, amsMapping2, note: chosen.note };
}

// True when the mapping for this slot and plate depends on the printer's AMS report, so the
// caller should wait for one before calling buildAmsMapping.
function needsAmsReport(amsSlot, plate) {
  return amsSlot != null && (amsSlot >= 0 || amsSlot === AMS_SLOT_MATCH) && !!plate && plate.used.length === 1;
}

module.exports = { readPlateFilaments, buildAmsMapping, liveTrays, needsAmsReport, AMS_SLOT_MATCH };
