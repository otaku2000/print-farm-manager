// Reads which filament a sliced .3mf prints with, in the browser, before anything is uploaded,
// and suggests the matching Material and Color from the filament library.
//
// A .3mf is a ZIP. Only two small entries are read, by seeking through the file with
// Blob.slice, so a large file is never loaded whole:
//   Metadata/slice_info.config       plate 1's <filament id type color> (id is 1-based)
//   Metadata/project_settings.config filament_settings_id, one per project filament, such as
//                                    "Bambu PETG HF @BBL H2S", and filament_vendor
// ZIP layout: PKWARE APPNOTE.TXT 4.3.7, 4.3.12, 4.3.16 (the same walk as server/zip-reader.js).
// Deflated entries are inflated with the browser's DecompressionStream('deflate-raw').
//
// The result is a suggestion: the color in a file is the slicer project's color, which is
// not always the spool the farm prints with. Callers fill the form and let the operator change it.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024; // the metadata entries are a few KB
const EOCD_SEARCH_BYTES = 66000;         // EOCD record (22 bytes) plus the longest ZIP comment

// RGB distance limit for naming a color, the same as server/printer-filaments.js
// (MAX_COLOR_DISTANCE): close enough for a library approximation of a real spool color,
// far enough from black to never call white "Black".
const MAX_COLOR_DISTANCE = 150;

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Returns { entryName: { offset, method, compressedSize, size } } from the central directory.
async function centralDirectory(blob) {
  const tailStart = Math.max(0, blob.size - EOCD_SEARCH_BYTES);
  const tail = await bytes(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const entries = {};
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== CENTRAL_SIG) return null;
    const method = u16(cd, p + 10);
    const compressedSize = u32(cd, p + 20);
    const size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const offset = u32(cd, p + 42);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { offset, method, compressedSize, size };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(blob, entries, name) {
  const e = entries[name];
  if (!e || e.size > MAX_ENTRY_BYTES || e.compressedSize > MAX_ENTRY_BYTES) return null;
  const local = await bytes(blob, e.offset, e.offset + 30);
  if (u32(local, 0) !== LOCAL_SIG) return null;
  const dataStart = e.offset + 30 + u16(local, 26) + u16(local, 28);
  const data = blob.slice(dataStart, dataStart + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(await data.arrayBuffer());
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') return null;
  const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

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

// "Bambu PETG HF @BBL H2S" with vendor "Bambu Lab" -> "PETG HF". The profile name, not the
// generic type ("PETG"), is what tells PETG HF from plain PETG.
export function materialFromProfile(profile, vendor) {
  if (!profile) return null;
  let name = String(profile).replace(/\s*@.*$/, '').trim();
  const prefixes = [vendor, vendor && vendor.split(/\s+/)[0], 'Generic'].filter(Boolean);
  for (const prefix of prefixes) {
    if (name.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) { name = name.slice(prefix.length + 1).trim(); break; }
  }
  return name || null;
}

// What a sliced .3mf says about itself: { material, type, color, printer }, or null when it
// is not a readable sliced .3mf. color is RRGGBB. printer is the slicer's printer name, such
// as "Bambu Lab H2S" (project_settings printer_model). material, type and color are null when
// plate 1 uses more than one filament, since a G-code targets a single material.
export async function readSlicedFilament(file) {
  try {
    if (!file || !/\.3mf$/i.test(file.name || '')) return null;
    const entries = await centralDirectory(file);
    if (!entries) return null;
    const sliceInfo = await readEntry(file, entries, 'Metadata/slice_info.config');
    if (!sliceInfo) return null;
    let settings = null;
    const settingsText = await readEntry(file, entries, 'Metadata/project_settings.config');
    if (settingsText) {
      try { settings = JSON.parse(settingsText); } catch (_) { settings = null; }
    }
    const printer = typeof settings?.printer_model === 'string' && settings.printer_model.trim()
      ? settings.printer_model.trim()
      : null;

    const plate = plateOneBlock(sliceInfo);
    const tags = plate ? plate.match(/<filament\b[^>]*>/gi) || [] : [];
    if (tags.length !== 1) return { material: null, type: null, color: null, printer };
    const id = parseInt(attr(tags[0], 'id'), 10);
    const type = attr(tags[0], 'type') || null;
    const colorMatch = /^#?([0-9a-f]{6})/i.exec(attr(tags[0], 'color') || '');

    let material = null;
    if (settings && Number.isInteger(id) && id >= 1) {
      const pick = (key) => (Array.isArray(settings[key]) ? settings[key][id - 1] : null);
      material = materialFromProfile(pick('filament_settings_id'), pick('filament_vendor'));
    }
    return { material: material || type, type, color: colorMatch ? colorMatch[1].toUpperCase() : null, printer };
  } catch (_) {
    return null;
  }
}

// Maps the slicer's printer name onto the farm's printer models (GET /api/models). Matches
// the model's label or id, case-insensitively, against the name with the vendor removed:
// "Bambu Lab H2S" -> "H2S" -> model h2s. Returns a model_id, or null when no model matches.
export function modelFromPrinter(printer, models) {
  if (!printer || !Array.isArray(models)) return null;
  const full = printer.trim().toLowerCase();
  const bare = full.replace(/^(bambu lab|bambulab|bambu|prusa|elegoo|creality|qidi)\s+/, '');
  const hit = models.find(m => {
    const label = String(m.label || '').trim().toLowerCase();
    const id = String(m.model_id || '').trim().toLowerCase();
    return [full, bare].some(n => n === label || n === id);
  });
  return hit ? hit.model_id : null;
}

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Maps what the file says onto the filament library. `types` is GET /api/filaments/types and
// `colors` GET /api/filaments/colors. Returns { material, color } with library names, either
// one null when the library has no match (never a guess).
export function suggestFromLibrary(found, types, colors) {
  if (!found) return { material: null, color: null };
  const byName = (n) => n && types.find(t => t.name.toLowerCase() === n.toLowerCase());
  const type = byName(found.material) || byName(found.type);
  if (!type) return { material: null, color: null };

  let color = null;
  const target = rgb(found.color);
  if (target) {
    let best = null;
    for (const c of colors) {
      if (c.type_name !== type.name) continue;
      const lib = rgb(c.hex_color);
      if (!lib) continue;
      const d = Math.hypot(target[0] - lib[0], target[1] - lib[1], target[2] - lib[2]);
      if (d <= MAX_COLOR_DISTANCE && (!best || d < best.d)) best = { name: c.name, d };
    }
    color = best ? best.name : null;
  }
  return { material: type.name, color };
}
