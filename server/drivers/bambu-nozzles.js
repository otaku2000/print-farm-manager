// Nozzle sizes: which nozzle a sliced Bambu file prints with, which nozzles a printer has
// installed, and whether the two agree.
//
// Sources (bambulab/BambuStudio, read for this module):
//   src/slic3r/GUI/DeviceCore/DevDefs.h   MAIN_EXTRUDER_ID 0, DEPUTY_EXTRUDER_ID 1 (physical
//                                         nozzle ids, as the printer reports them);
//                                         LOGIC_L_EXTRUDER_ID 0, LOGIC_R_EXTRUDER_ID 1
//   src/slic3r/GUI/DeviceCore/DevMappingNozzle.cpp  displays physical 0 as "R" and 1 as "L",
//                                         and writes a file nozzle's extruder as extruder_id + 1
//   src/libslic3r/PrintConfig.hpp         physical_extruder_map (logical extruder -> physical)
//
// File side: Metadata/slice_info.config lists the nozzles plate 1 uses as
//   <nozzle id="1" extruder_id="2" nozzle_diameter="0.4" .../>
// where extruder_id is the 1-based logical extruder. Metadata/project_settings.config
// carries physical_extruder_map, so the physical nozzle is physical_extruder_map[extruder_id - 1].
// A single-nozzle file (H2S) has one nozzle, logical and physical 0.
//
// Printer side: the MQTT report's device.nozzle.info is a list of { id, diameter, type };
// a single-nozzle printer also reports top-level nozzle_diameter.
// Read from live H2S and H2D reports: an H2D lists ids 0 and 1, an H2S only id 0.

const fs  = require('fs');
const zip = require('../zip-reader');

// Diameters are written as "0.4" or "0.40": compare as numbers within this tolerance.
const DIAMETER_TOLERANCE = 0.001;

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

// Nozzles plate 1 of a sliced .3mf prints with: [{ physicalId, diameter }], or null when
// the file does not say (not a .3mf, an older slicer, or no nozzle list). Files never change
// after upload, so results are cached by path.
const plateCache = new Map();
function readPlateNozzles(filePath) {
  if (plateCache.has(filePath)) return plateCache.get(filePath);
  let result = null;
  try {
    const buf = fs.readFileSync(filePath);
    const sliceInfo = zip.readEntry(buf, 'Metadata/slice_info.config');
    const plate = sliceInfo && plateOneBlock(sliceInfo.toString('utf8'));
    const tags = plate ? plate.match(/<nozzle\b[^>]*>/gi) || [] : [];
    if (tags.length > 0) {
      let physicalMap = null;
      const settings = zip.readEntry(buf, 'Metadata/project_settings.config');
      if (settings) {
        try {
          const map = JSON.parse(settings.toString('utf8')).physical_extruder_map;
          if (Array.isArray(map)) physicalMap = map.map(v => parseInt(v, 10));
        } catch (_) {}
      }
      const nozzles = [];
      for (const tag of tags) {
        const logical = parseInt(attr(tag, 'extruder_id'), 10) - 1;
        const diameter = parseFloat(attr(tag, 'nozzle_diameter'));
        if (!Number.isInteger(logical) || logical < 0 || !(diameter > 0)) continue;
        const mapped = physicalMap ? physicalMap[logical] : (logical === 0 ? 0 : NaN);
        if (!Number.isInteger(mapped)) continue;
        nozzles.push({ physicalId: mapped, diameter });
      }
      result = nozzles.length > 0 ? nozzles : null;
    }
  } catch (_) {
    result = null;
  }
  plateCache.set(filePath, result);
  return result;
}

// Installed nozzles from a cached MQTT report: [{ id, diameter, type }], or null before
// the printer has reported them.
function liveNozzles(latestPrint) {
  const info = latestPrint?.device?.nozzle?.info;
  if (Array.isArray(info) && info.length > 0) {
    const out = [];
    for (const n of info) {
      const id = parseInt(n.id, 10);
      const diameter = parseFloat(n.diameter);
      if (!Number.isInteger(id) || !(diameter > 0)) continue;
      out.push({ id, diameter, type: n.type || null });
    }
    if (out.length > 0) return out.sort((a, b) => a.id - b.id);
  }
  const single = parseFloat(latestPrint?.nozzle_diameter);
  if (single > 0) return [{ id: 0, diameter: single, type: latestPrint.nozzle_type || null }];
  return null;
}

// Display name for a physical nozzle id on a printer with `count` nozzles.
function nozzleLabel(id, count) {
  if (count <= 1) return 'Nozzle';
  if (id === 0) return 'Right nozzle';
  if (id === 1) return 'Left nozzle';
  return `Nozzle ${id}`;
}

function fmt(d) {
  return `${Number(d.toFixed(2))} mm`;
}

// Compares what the file needs with what is installed. Returns null when they agree or
// either side is unknown (nothing to check against), else a sentence for logs and the UI.
function nozzleMismatch(required, installed) {
  if (!required || !installed) return null;
  for (const need of required) {
    const have = installed.find(n => n.id === need.physicalId);
    if (!have) {
      return `the file prints on ${nozzleLabel(need.physicalId, 2).toLowerCase()} (${fmt(need.diameter)}), which this printer does not report`;
    }
    if (Math.abs(have.diameter - need.diameter) > DIAMETER_TOLERANCE) {
      return `the file is sliced for a ${fmt(need.diameter)} nozzle but the ${nozzleLabel(have.id, installed.length).toLowerCase()} is ${fmt(have.diameter)}`;
    }
  }
  return null;
}

module.exports = { readPlateNozzles, liveNozzles, nozzleMismatch, nozzleLabel, DIAMETER_TOLERANCE };
