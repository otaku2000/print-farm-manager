const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildZip } = require('./helpers/build-zip');
const { readPlateFilaments, buildAmsMapping, needsAmsReport } = require('../drivers/bambu-ams');

// slice_info.config and project_settings.config as Bambu Studio writes them (trimmed to the
// fields read here; attribute layout copied from a real H2S export).
function sliceInfo(filaments) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
${filaments.map(f => `    <filament id="${f.id}" tray_info_idx="GFG02" type="${f.type}" color="${f.color}" used_m="3.57" used_g="11.00"/>`).join('\n')}
  </plate>
</config>`;
}

function write3mf(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ams-')), 'plate.gcode.3mf');
  fs.writeFileSync(file, buildZip(entries, { deflate: true }));
  return file;
}

// The printer's AMS report, in the shape of a pushall report.
function amsReport(trays) {
  return { ams: { ams: [{ id: '0', tray: trays.map((t, i) => ({ id: String(i), tray_type: t[0], tray_color: t[1] })) }] } };
}

// BL-H2S-004 as it was loaded when it paused with "Failed to get AMS mapping table".
const H2S_004 = amsReport([['ABS-GF', '000000FF'], ['PETG', '000000FF'], ['ABS-GF', '0C3B95FF'], ['PET-CF', '000000FF']]);

describe('readPlateFilaments', () => {
  test('reads the plate filament with a 0-based index and the project filament count', () => {
    const file = write3mf({
      'Metadata/slice_info.config': sliceInfo([{ id: 2, type: 'PETG', color: '#CAD1EE' }]),
      'Metadata/project_settings.config': JSON.stringify({ filament_type: ['PETG', 'PETG'] }),
    });
    expect(readPlateFilaments(file)).toEqual({ filamentCount: 2, used: [{ index: 1, type: 'PETG', color: 'CAD1EE' }] });
  });

  test('without project settings the count covers the highest used filament', () => {
    const file = write3mf({ 'Metadata/slice_info.config': sliceInfo([{ id: 3, type: 'PLA', color: '#FFFFFF' }]) });
    expect(readPlateFilaments(file).filamentCount).toBe(3);
  });

  test('returns null for a missing file or one without slice info', () => {
    expect(readPlateFilaments('/nonexistent/plate.3mf')).toBeNull();
    expect(readPlateFilaments(write3mf({ '3D/3dmodel.model': 'x' }))).toBeNull();
  });
});

describe('buildAmsMapping', () => {
  const plate = (index, type = 'PETG', color = '000000', filamentCount = index + 1) =>
    ({ filamentCount, used: [{ index, type, color }] });

  test('external spool or no slot: use_ams false, empty mapping', () => {
    expect(buildAmsMapping({ printerName: 'P', amsSlot: -1, plate: plate(0), latestPrint: H2S_004 }))
      .toEqual({ useAms: false, amsMapping: [], amsMapping2: null, note: null });
    expect(buildAmsMapping({ printerName: 'P', amsSlot: null, plate: plate(0), latestPrint: H2S_004 }).useAms).toBe(false);
  });

  test('no filament list in the file: sends the configured slot as before', () => {
    expect(buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: null, latestPrint: H2S_004 }))
      .toEqual({ useAms: true, amsMapping: [3], amsMapping2: null, note: null });
  });

  test('regression: a plate printing filament 2 maps index 1 and marks filament 1 unused', () => {
    // The Servo Mount job went out as [3], which mapped filament 1 and left filament 2 unmapped.
    const r = buildAmsMapping({ printerName: 'P', amsSlot: 1, plate: plate(1, 'PETG', 'CAD1EE', 2), latestPrint: H2S_004 });
    expect(r.amsMapping).toEqual([-1, 1]);
    expect(r.amsMapping2).toEqual([{ ams_id: 255, slot_id: 255 }, { ams_id: 0, slot_id: 1 }]);
    expect(r.note).toBeNull();
  });

  test('regression: configured slot holds another type, moves to the tray with the right type', () => {
    const r = buildAmsMapping({ printerName: 'BL-H2S-004', amsSlot: 3, plate: plate(0), latestPrint: H2S_004 });
    expect(r.amsMapping).toEqual([1]);
    expect(r.amsMapping2).toEqual([{ ams_id: 0, slot_id: 1 }]);
    expect(r.note).toMatch(/slot 4 holds PET-CF, using slot 2/);
  });

  test('prefers a tray whose color also matches', () => {
    const latestPrint = amsReport([['PLA', 'FF0000FF'], ['PETG', 'FFFFFFFF'], ['PETG', 'CAD1EEFF'], ['ABS', '000000FF']]);
    const r = buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: plate(0, 'PETG', 'CAD1EE'), latestPrint });
    expect(r.amsMapping).toEqual([2]);
  });

  test('type comparison ignores case', () => {
    const r = buildAmsMapping({ printerName: 'P', amsSlot: 1, plate: plate(0, 'petg'), latestPrint: H2S_004 });
    expect(r.amsMapping).toEqual([1]);
    expect(r.note).toBeNull();
  });

  test('regression: no AMS report yet throws AMS_UNKNOWN instead of trusting the configured slot', () => {
    // A recommission dispatch on a fresh connection sent slot 4 (PET-CF) for a PETG plate.
    expect(() => buildAmsMapping({ printerName: 'BL-H2S-004', amsSlot: 3, plate: plate(0), latestPrint: null }))
      .toThrow(expect.objectContaining({ code: 'AMS_UNKNOWN' }));
    expect(() => buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: plate(0), latestPrint: { gcode_state: 'IDLE' } }))
      .toThrow(expect.objectContaining({ code: 'AMS_UNKNOWN' }));
  });

  test('an empty configured tray is not a match', () => {
    const latestPrint = { ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PETG' }, { id: '1' }, { id: '2' }, { id: '3' }] }] } };
    const r = buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: plate(0), latestPrint });
    expect(r.amsMapping).toEqual([0]);
    expect(r.note).toMatch(/slot 4 holds nothing, using slot 1/);
  });

  test('a configured tray missing from the report is not trusted', () => {
    const partial = amsReport([['PLA', 'FFFFFFFF']]);
    expect(() => buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: plate(0), latestPrint: partial }))
      .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH' }));
  });

  test('BL-H2S-004 as loaded after the failed dispatch: no PETG anywhere is refused', () => {
    const latestPrint = { ams: { ams: [{ id: '0', tray: [
      { id: '0', tray_type: 'ABS-GF' }, { id: '1' }, { id: '2' }, { id: '3', tray_type: 'PET-CF' },
    ] }] } };
    expect(() => buildAmsMapping({ printerName: 'BL-H2S-004', amsSlot: 3, plate: plate(1, 'PETG', 'CAD1EE', 2), latestPrint }))
      .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH', message: expect.stringMatching(/slot 4 holds PET-CF/) }));
  });

  test('throws AMS_NO_MATCH when no tray holds the needed type', () => {
    expect(() => buildAmsMapping({ printerName: 'BL-H2S-004', amsSlot: 0, plate: plate(0, 'TPU'), latestPrint: H2S_004 }))
      .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH', message: expect.stringMatching(/BL-H2S-004 has no TPU/) }));
  });

  test('throws AMS_MULTI_FILAMENT for a plate that uses more than one filament', () => {
    const multi = { filamentCount: 2, used: [{ index: 0, type: 'PETG', color: null }, { index: 1, type: 'PLA', color: null }] };
    expect(() => buildAmsMapping({ printerName: 'P', amsSlot: 0, plate: multi, latestPrint: H2S_004 }))
      .toThrow(expect.objectContaining({ code: 'AMS_MULTI_FILAMENT' }));
  });

  describe('match from AMS (amsSlot -2)', () => {
    test('picks the tray holding the file filament type, preferring its color', () => {
      const latestPrint = amsReport([['PETG', 'FFFFFFFF'], ['ABS-GF', '000000FF'], ['PETG', 'CAD1EEFF'], ['PET-CF', '000000FF']]);
      const r = buildAmsMapping({ printerName: 'P', amsSlot: -2, plate: plate(1, 'PETG', 'CAD1EE', 2), latestPrint });
      expect(r.amsMapping).toEqual([-1, 2]);
      expect(r.amsMapping2).toEqual([{ ams_id: 255, slot_id: 255 }, { ams_id: 0, slot_id: 2 }]);
      expect(r.note).toMatch(/matched slot 3/);
    });

    test('falls back to the first tray of the type when no color matches', () => {
      const r = buildAmsMapping({ printerName: 'P', amsSlot: -2, plate: plate(0, 'PETG', 'FF0000'), latestPrint: H2S_004 });
      expect(r.amsMapping).toEqual([1]);
    });

    test('throws AMS_NO_MATCH when no tray has the type', () => {
      expect(() => buildAmsMapping({ printerName: 'BL-H2S-004', amsSlot: -2, plate: plate(0, 'TPU'), latestPrint: H2S_004 }))
        .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH', message: expect.stringMatching(/no TPU/) }));
    });

    test('throws AMS_UNKNOWN before the AMS has reported', () => {
      expect(() => buildAmsMapping({ printerName: 'P', amsSlot: -2, plate: plate(0), latestPrint: null }))
        .toThrow(expect.objectContaining({ code: 'AMS_UNKNOWN' }));
    });

    test('throws AMS_NO_FILE_INFO when the file does not list its filament or type', () => {
      expect(() => buildAmsMapping({ printerName: 'P', amsSlot: -2, plate: null, latestPrint: H2S_004 }))
        .toThrow(expect.objectContaining({ code: 'AMS_NO_FILE_INFO' }));
      expect(() => buildAmsMapping({ printerName: 'P', amsSlot: -2, plate: plate(0, ''), latestPrint: H2S_004 }))
        .toThrow(expect.objectContaining({ code: 'AMS_NO_FILE_INFO' }));
    });

    test('needsAmsReport is true for match mode with a single-filament plate', () => {
      expect(needsAmsReport(-2, plate(0))).toBe(true);
      expect(needsAmsReport(-1, plate(0))).toBe(false);
      expect(needsAmsReport(-2, null)).toBe(false);
    });
  });

  test('a second AMS unit maps to ams_id 1', () => {
    const latestPrint = { ams: { ams: [
      { id: '0', tray: [{ id: '0', tray_type: 'PLA' }] },
      { id: '1', tray: [{ id: '0', tray_type: 'PLA' }, { id: '1', tray_type: 'PETG', tray_color: '000000FF' }] },
    ] } };
    const r = buildAmsMapping({ printerName: 'P', amsSlot: 0, plate: plate(0), latestPrint });
    expect(r.amsMapping).toEqual([5]);
    expect(r.amsMapping2).toEqual([{ ams_id: 1, slot_id: 1 }]);
  });
});
