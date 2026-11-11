const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildZip } = require('./helpers/build-zip');
const { readPlateFilaments, buildAmsMapping, needsAmsReport, liveTrays } = require('../drivers/bambu-ams');

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

  test('external spool or no slot on a one-holder printer: use_ams false, empty mapping', () => {
    expect(buildAmsMapping({ printerName: 'P', amsSlot: -1, plate: plate(0), latestPrint: H2S_004 }))
      .toEqual({ useAms: false, amsMapping: [], amsMapping2: null, note: 'printing from the right external spool (type not reported, not checked)', tray: -1 });
    expect(buildAmsMapping({ printerName: 'P', amsSlot: -1, plate: null, latestPrint: H2S_004 }))
      .toEqual({ useAms: false, amsMapping: [], amsMapping2: null, note: null, tray: -1 });
    expect(buildAmsMapping({ printerName: 'P', amsSlot: null, plate: plate(0), latestPrint: H2S_004 }).useAms).toBe(false);
  });

  test('no filament list in the file: sends the configured slot as before', () => {
    expect(buildAmsMapping({ printerName: 'P', amsSlot: 3, plate: null, latestPrint: H2S_004 }))
      .toEqual({ useAms: true, amsMapping: [3], amsMapping2: null, note: null, tray: 3 });
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
    expect(r.tray).toBe(1); // the tray actually used, reported back for spool tracking
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
      expect(needsAmsReport(-1, plate(0))).toBe(true);
      expect(needsAmsReport(-1, null)).toBe(false);
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

// An H2D as the farm reports one: the AMS feeds the right nozzle (info bits 8-11 = 0) and
// both external holders arrive in vir_slot (255 right, 254 left).
function h2d({ ams = [['PLA', 'FFFFFFFF'], ['PETG', '000000FF'], ['', ''], ['', '']], info = '10001003', right = '', left = '' } = {}) {
  return {
    ams: { ams: [{ id: '0', info, tray: ams.map((t, i) => ({ id: String(i), tray_type: t[0], tray_color: t[1] })) }] },
    vir_slot: [
      { id: '255', tray_type: right, tray_color: right ? '00AE42FF' : '' },
      { id: '254', tray_type: left, tray_color: left ? 'FF0000FF' : '' },
    ],
  };
}

describe('H2D nozzle mapping', () => {
  const plate = (type = 'PETG', color = '000000') => ({ filamentCount: 1, used: [{ index: 0, type, color }] });

  test('liveTrays reads the AMS nozzle from info and both external holders', () => {
    const trays = liveTrays(h2d({ left: 'TPU', info: '10001103' }));
    expect(trays.filter(t => !t.external).every(t => t.nozzle === 1)).toBe(true);
    expect(trays.filter(t => t.external).map(t => [t.tray, t.nozzle, t.type])).toEqual([[255, 0, ''], [254, 1, 'TPU']]);
    expect(liveTrays(h2d({ info: '10000E03' }))[0].nozzle).toBeNull();
  });

  test('older printers: vt_tray is the right holder', () => {
    const trays = liveTrays({ ams: { ams: [] }, vt_tray: { id: '254', tray_type: 'PLA', tray_color: 'FFFFFFFF' } });
    expect(trays).toEqual([expect.objectContaining({ tray: 255, nozzle: 0, external: true, type: 'PLA' })]);
  });

  test('match from AMS for a left-nozzle file skips the right-nozzle AMS and uses the left external spool', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: -2, plate: plate('TPU'), latestPrint: h2d({ ams: [['TPU', '000000FF']], left: 'TPU' }), nozzle: 1 });
    expect(r).toMatchObject({ useAms: false, amsMapping: [-1], amsMapping2: [{ ams_id: 254, slot_id: 0 }], tray: -1 });
  });

  test('match from AMS for a right-nozzle file uses the AMS', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: -2, plate: plate('PETG'), latestPrint: h2d({ left: 'PETG' }), nozzle: 0 });
    expect(r).toMatchObject({ useAms: true, amsMapping: [1], amsMapping2: [{ ams_id: 0, slot_id: 1 }], tray: 1 });
  });

  test('match from AMS prefers the AMS over the external spool on the same nozzle', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: -2, plate: plate('PETG'), latestPrint: h2d({ right: 'PETG' }), nozzle: 0 });
    expect(r.useAms).toBe(true);
  });

  test('match from AMS refuses when the only spool of the type feeds the other nozzle', () => {
    expect(() => buildAmsMapping({ printerName: 'H2D', amsSlot: -2, plate: plate('PETG'), latestPrint: h2d(), nozzle: 1 }))
      .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH', message: expect.stringContaining('on the left nozzle') }));
  });

  test('a fixed AMS slot feeding the other nozzle moves to a reachable spool', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: 1, plate: plate('PETG'), latestPrint: h2d({ left: 'PETG' }), nozzle: 1 });
    expect(r).toMatchObject({ useAms: false, amsMapping2: [{ ams_id: 254, slot_id: 0 }] });
    expect(r.note).toContain('for the right nozzle');
  });

  test('external spool (-1) picks the holder on the file nozzle', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: -1, plate: plate('TPU'), latestPrint: h2d({ left: 'TPU' }), nozzle: 1 });
    expect(r).toMatchObject({ useAms: false, amsMapping: [-1], amsMapping2: [{ ams_id: 254, slot_id: 0 }], tray: -1 });
  });

  test('an explicit holder on the wrong side is refused', () => {
    expect(() => buildAmsMapping({ printerName: 'H2D', amsSlot: 255, plate: plate('TPU'), latestPrint: h2d({ right: 'TPU' }), nozzle: 1 }))
      .toThrow(expect.objectContaining({ code: 'AMS_WRONG_NOZZLE' }));
  });

  test('an external holder with another type is refused', () => {
    expect(() => buildAmsMapping({ printerName: 'H2D', amsSlot: -1, plate: plate('TPU'), latestPrint: h2d({ left: 'PETG' }), nozzle: 1 }))
      .toThrow(expect.objectContaining({ code: 'AMS_NO_MATCH' }));
  });

  test('without the file nozzle any tray will do, as before', () => {
    const r = buildAmsMapping({ printerName: 'H2D', amsSlot: -2, plate: plate('PETG'), latestPrint: h2d(), nozzle: null });
    expect(r.useAms).toBe(true);
  });
});
