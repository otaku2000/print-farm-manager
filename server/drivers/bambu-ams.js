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

// Which nozzle each tray feeds, and the external spool holders.
//
// From bambulab/BambuStudio:
//   src/slic3r/GUI/DeviceCore/DevFilaSystem.cpp  an AMS unit's "info" is a hex string; bits 8-11
//       are the extruder (nozzle) it feeds ("extuder_id = DevUtil::get_flag_bits(info, 8, 4)");
//       0xE means not bound to one nozzle. External holders arrive as "vir_slot" (older
//       printers send a single "vt_tray", which Studio treats as the main holder).
//   src/slic3r/GUI/DeviceCore/DevDefs.h  VIRTUAL_TRAY_MAIN_ID 255, VIRTUAL_TRAY_DEPUTY_ID 254;
//       MAIN_EXTRUDER_ID 0 (right), DEPUTY_EXTRUDER_ID 1 (left). SelectMachine.cpp names
//       255 "Right-Ext" and 254 "Left-Ext".
//   src/slic3r/GUI/DeviceCore/DevMapping.cpp  an external spool maps as its holder id with
//       slot_id 0; SelectMachine.cpp sends it as -1 in ams_mapping and { ams_id: 255 or 254,
//       slot_id: 0 } in ams_mapping2, with use_ams false when only external spools are used.
// Read from live H2D and H2S reports: every AMS on the farm reports info 10001003 (feeds the
// right nozzle), and H2-series printers send both external holders in vir_slot.
const EXT_RIGHT = 255;
const EXT_LEFT = 254;
const NOZZLE_RIGHT = 0;
const NOZZLE_LEFT = 1;

const extForNozzle = (nozzle) => (nozzle === NOZZLE_LEFT ? EXT_LEFT : EXT_RIGHT);
const nozzleOfExt = (id) => (id === EXT_LEFT ? NOZZLE_LEFT : NOZZLE_RIGHT);
const isExternalSlot = (v) => v === EXT_RIGHT || v === EXT_LEFT;

function amsNozzle(info) {
  const n = parseInt(info, 16);
  if (!Number.isFinite(n)) return null;
  const extruder = Math.floor(n / 256) & 0xF;
  return extruder === NOZZLE_RIGHT || extruder === NOZZLE_LEFT ? extruder : null;
}

function trayFields(t) {
  return {
    type: t.tray_type || '',
    subBrand: t.tray_sub_brands || '',
    color: t.tray_color ? String(t.tray_color).slice(0, 6).toUpperCase() : null,
    remain: typeof t.remain === 'number' ? t.remain : null,
  };
}

// Flattens the printer's live report into trays:
//   { tray, amsId, slotId, nozzle, external, type, subBrand, color, remain }
// tray is the AMS compound id (ams_id * 4 + slot_id) or, for an external holder, its id
// (255 right, 254 left). nozzle is 0 (right), 1 (left), or null when the report does not
// bind the tray to one nozzle. Returns null when no AMS report has arrived yet.
function liveTrays(latestPrint) {
  const units = latestPrint?.ams?.ams;
  if (!Array.isArray(units)) return null;
  const trays = [];
  for (const unit of units) {
    const amsId = parseInt(unit.id, 10);
    if (!Number.isInteger(amsId)) continue;
    const nozzle = amsNozzle(unit.info);
    for (const t of unit.tray || []) {
      const slotId = parseInt(t.id, 10);
      if (!Number.isInteger(slotId)) continue;
      trays.push({ tray: amsId * SLOTS_PER_AMS + slotId, amsId, slotId, nozzle, external: false, ...trayFields(t) });
    }
  }
  const holders = Array.isArray(latestPrint.vir_slot)
    ? latestPrint.vir_slot
    : (latestPrint.vt_tray ? [{ ...latestPrint.vt_tray, id: String(EXT_RIGHT) }] : []);
  for (const v of holders) {
    const id = parseInt(v.id, 10);
    if (!isExternalSlot(id)) continue;
    trays.push({ tray: id, amsId: id, slotId: 0, nozzle: nozzleOfExt(id), external: true, ...trayFields(v) });
  }
  return trays;
}

function sameType(a, b) {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

const sideName = (nozzle) => (nozzle === NOZZLE_LEFT ? 'left' : nozzle === NOZZLE_RIGHT ? 'right' : null);

function trayLabel(t) {
  if (t.external) return `${sideName(t.nozzle)} external spool`;
  return `slot ${t.tray + 1}`;
}

// Picks the tray for the plate's filament on the nozzle the file prints with (`nozzle`, null
// when the file or printer does not say: then any tray will do).
//   configured null        match from the AMS: a tray of the file's type, preferring its color,
//                          AMS before external spool
//   configured -1          the external spool on the file's nozzle
//   configured 255 or 254  that external holder
//   configured 0 and up    that AMS tray, moved to another tray of the right type when it holds
//                          the wrong filament or feeds the other nozzle
// Never guesses: with no AMS report, or no tray of the type on that nozzle, it throws. An
// external spool whose type the printer does not report is used as configured, with a note.
function chooseTray(printerName, filament, configured, trays, nozzle = null) {
  const reachable = (t) => nozzle == null || t.nozzle == null || t.nozzle === nozzle;
  const onNozzle = nozzle == null ? '' : ` on the ${sideName(nozzle)} nozzle`;

  if (configured === -1 || isExternalSlot(configured)) {
    const id = configured === -1 ? extForNozzle(nozzle) : configured;
    if (nozzle != null && nozzleOfExt(id) !== nozzle) {
      const err = new Error(`${printerName}: the G-code is set to the ${sideName(nozzleOfExt(id))} external spool, but the file prints with the ${sideName(nozzle)} nozzle`);
      err.code = 'AMS_WRONG_NOZZLE';
      throw err;
    }
    const holder = (trays || []).find(t => t.tray === id);
    if (holder && holder.type && filament.type && !sameType(holder.type, filament.type)) {
      const err = new Error(`${printerName}: the ${trayLabel(holder)} holds ${holder.type}, but the file needs ${filament.type}`);
      err.code = 'AMS_NO_MATCH';
      throw err;
    }
    const side = sideName(nozzleOfExt(id));
    return {
      tray: id, amsId: id, slotId: 0, external: true,
      note: holder && holder.type ? `printing from the ${side} external spool (${holder.type})` : `printing from the ${side} external spool (type not reported, not checked)`,
    };
  }

  if (!trays) {
    const err = new Error(`${printerName} has not reported its AMS contents yet, so the filament slot cannot be checked`);
    err.code = 'AMS_UNKNOWN';
    throw err;
  }
  const matching = configured == null;
  const fixed = { tray: configured, amsId: Math.floor(configured / SLOTS_PER_AMS), slotId: configured % SLOTS_PER_AMS, external: false };
  const current = matching ? null : trays.find(t => !t.external && t.tray === configured);

  if (!filament.type) {
    if (matching) {
      const err = new Error('the sliced file names no filament type, so no AMS slot can be matched; give the G-code a fixed slot');
      err.code = 'AMS_NO_FILE_INFO';
      throw err;
    }
    if (current && !reachable(current)) {
      const err = new Error(`${printerName}: AMS ${trayLabel(current)} feeds the ${sideName(current.nozzle)} nozzle, but the file prints with the ${sideName(nozzle)} nozzle`);
      err.code = 'AMS_WRONG_NOZZLE';
      throw err;
    }
    // A file that names no type gives nothing to check against: use the configured slot.
    return { ...fixed, note: null };
  }

  let held = null;
  if (!matching) {
    if (current && current.type && sameType(current.type, filament.type) && reachable(current)) {
      return { ...fixed, note: null };
    }
    held = !current || !current.type ? 'nothing'
      : !reachable(current) ? `${current.type} for the ${sideName(current.nozzle)} nozzle`
        : current.type;
  }

  const matches = trays.filter(t => t.type && sameType(t.type, filament.type) && reachable(t));
  if (matches.length === 0) {
    const loaded = trays.filter(t => t.type)
      .map(t => `${trayLabel(t)} ${t.type}${!t.external && t.nozzle != null && nozzle != null ? ` (${sideName(t.nozzle)} nozzle)` : ''}`)
      .join(', ') || 'nothing';
    const err = new Error(matching
      ? `${printerName} has no ${filament.type}${onNozzle} (loaded: ${loaded})`
      : `${printerName} has no ${filament.type}${onNozzle} (configured slot ${configured + 1} holds ${held}; loaded: ${loaded})`);
    err.code = 'AMS_NO_MATCH';
    throw err;
  }
  // Same color first, then AMS before an external spool.
  const rank = (t) => (filament.color && t.color === filament.color ? 0 : 2) + (t.external ? 1 : 0);
  const pick = [...matches].sort((a, b) => rank(a) - rank(b))[0];
  return {
    ...pick,
    note: matching
      ? `matched ${trayLabel(pick)} (${pick.type}${pick.color ? ` #${pick.color}` : ''})${onNozzle}`
      : `configured slot ${configured + 1} holds ${held}, using ${trayLabel(pick)} (${pick.type}) instead`,
  };
}

// Returns { useAms, amsMapping, amsMapping2, note, tray } for the project_file payload.
// amsSlot is the G-code's filament source: AMS_SLOT_MATCH (-2) match from the AMS, -1 or null
// the external spool on the file's nozzle, 255/254 a particular external holder, 0 and up a
// fixed AMS tray. nozzle is the physical nozzle the file prints with (0 right, 1 left), or
// null when unknown. The result's `tray` is the tray the print feeds from (compound AMS id,
// or -1 for an external spool), so callers can record which spool was used.
function buildAmsMapping({ printerName, amsSlot, plate, latestPrint, nozzle = null }) {
  const matching = amsSlot === AMS_SLOT_MATCH;
  const external = amsSlot == null || amsSlot === -1 || isExternalSlot(amsSlot);
  if (external && (!plate || plate.used.length !== 1)) {
    // Nothing to index by, or a multi-filament plate: the external spool as it always was.
    return { useAms: false, amsMapping: [], amsMapping2: null, note: null, tray: -1 };
  }
  if (!plate) {
    if (matching) {
      const err = new Error('the sliced file does not list its filament, so no AMS slot can be matched; give the G-code a fixed slot');
      err.code = 'AMS_NO_FILE_INFO';
      throw err;
    }
    // Without the file's filament list there is nothing to index by: send the slot as before.
    return { useAms: true, amsMapping: [amsSlot], amsMapping2: null, note: null, tray: amsSlot };
  }
  if (plate.used.length > 1) {
    const err = new Error(
      `plate 1 uses ${plate.used.length} filaments; the farm maps one AMS slot per G-code, so multi-filament plates are not supported`
    );
    err.code = 'AMS_MULTI_FILAMENT';
    throw err;
  }

  const filament = plate.used[0];
  const configured = external ? (amsSlot == null ? -1 : amsSlot) : (matching ? null : amsSlot);
  const trays = liveTrays(latestPrint);
  const chosen = chooseTray(printerName, filament, configured, trays, nozzle);

  // A printer with one external holder gets the external-spool payload it has always had;
  // only a two-holder printer (H2D) needs to be told which holder.
  if (chosen.external && !(trays || []).some(t => t.tray === EXT_LEFT)) {
    return { useAms: false, amsMapping: [], amsMapping2: null, note: chosen.note, tray: -1 };
  }

  const amsMapping  = Array(plate.filamentCount).fill(UNUSED_TRAY);
  const amsMapping2 = Array.from({ length: plate.filamentCount }, () => ({ ams_id: UNUSED_AMS_ID, slot_id: UNUSED_AMS_ID }));
  amsMapping[filament.index]  = chosen.external ? UNUSED_TRAY : chosen.tray;
  amsMapping2[filament.index] = { ams_id: chosen.amsId, slot_id: chosen.slotId };

  return {
    useAms: !chosen.external, amsMapping, amsMapping2, note: chosen.note,
    tray: chosen.external ? -1 : chosen.tray,
  };
}

// True when the mapping for this slot and plate depends on the printer's report, so the
// caller should wait for one before calling buildAmsMapping.
function needsAmsReport(amsSlot, plate) {
  return !!plate && plate.used.length === 1 && (amsSlot == null || amsSlot >= -2);
}

module.exports = {
  readPlateFilaments, buildAmsMapping, liveTrays, needsAmsReport,
  AMS_SLOT_MATCH, EXT_RIGHT, EXT_LEFT, isExternalSlot,
};
