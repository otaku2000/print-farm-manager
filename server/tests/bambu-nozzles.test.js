const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildZip } = require('./helpers/build-zip');
const { readPlateNozzles, liveNozzles, nozzleMismatch } = require('../drivers/bambu-nozzles');

// slice_info.config and project_settings.config fields as Bambu Studio writes them for
// the farm's real H2D and H2S files (trimmed to what is read).
function write3mf({ nozzles, physicalMap }) {
  const sliceInfo = `<config><plate><metadata key="index" value="1"/>
${nozzles.map(n => `<nozzle id="${n.id}" extruder_id="${n.extruderId}" nozzle_diameter="${n.diameter}" volume_type="Standard"/>`).join('\n')}
</plate></config>`;
  const entries = { 'Metadata/slice_info.config': sliceInfo };
  if (physicalMap) entries['Metadata/project_settings.config'] = JSON.stringify({ physical_extruder_map: physicalMap });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nozzle-')), 'plate.gcode.3mf');
  fs.writeFileSync(file, buildZip(entries, { deflate: true }));
  return file;
}

// device.nozzle.info as BL-H2D-002 reported it: right (id 0) 0.4 mm, left (id 1) 0.6 mm.
const H2D_002 = { device: { nozzle: { info: [
  { id: 0, diameter: 0.4, type: 'HS01' },
  { id: 1, diameter: 0.6, type: 'HS01' },
] } } };
const H2S = { device: { nozzle: { info: [{ id: 0, diameter: 0.4, type: 'HS01' }] } }, nozzle_diameter: '0.4' };

describe('readPlateNozzles', () => {
  test('H2D file on the right extruder maps to physical nozzle 0', () => {
    // extruder_id 2 is logical right (index 1); physical_extruder_map ["1","0"] sends it to 0.
    const file = write3mf({ nozzles: [{ id: 1, extruderId: 2, diameter: '0.4' }], physicalMap: ['1', '0'] });
    expect(readPlateNozzles(file)).toEqual([{ physicalId: 0, diameter: 0.4 }]);
  });

  test('H2D file on the left extruder maps to physical nozzle 1', () => {
    const file = write3mf({ nozzles: [{ id: 0, extruderId: 1, diameter: '0.6' }], physicalMap: ['1', '0'] });
    expect(readPlateNozzles(file)).toEqual([{ physicalId: 1, diameter: 0.6 }]);
  });

  test('H2S file uses nozzle 0', () => {
    const file = write3mf({ nozzles: [{ id: 0, extruderId: 1, diameter: '0.4' }], physicalMap: ['0'] });
    expect(readPlateNozzles(file)).toEqual([{ physicalId: 0, diameter: 0.4 }]);
  });

  test('null when the file lists no nozzles or is not a sliced 3mf', () => {
    expect(readPlateNozzles(write3mf({ nozzles: [] }))).toBeNull();
    expect(readPlateNozzles('/nonexistent/plate.3mf')).toBeNull();
  });
});

describe('liveNozzles', () => {
  test('reads device.nozzle.info sorted by id', () => {
    expect(liveNozzles(H2D_002)).toEqual([
      { id: 0, diameter: 0.4, type: 'HS01' },
      { id: 1, diameter: 0.6, type: 'HS01' },
    ]);
  });

  test('falls back to the top-level nozzle_diameter on a single-nozzle printer', () => {
    expect(liveNozzles({ nozzle_diameter: '0.6', nozzle_type: 'hardened_steel' }))
      .toEqual([{ id: 0, diameter: 0.6, type: 'hardened_steel' }]);
  });

  test('null before any report', () => {
    expect(liveNozzles(null)).toBeNull();
    expect(liveNozzles({ gcode_state: 'IDLE' })).toBeNull();
  });
});

describe('nozzleMismatch', () => {
  test('0.4 mm file on the right nozzle of BL-H2D-002 is fine', () => {
    expect(nozzleMismatch([{ physicalId: 0, diameter: 0.4 }], liveNozzles(H2D_002))).toBeNull();
  });

  test('0.4 mm file on the left nozzle of BL-H2D-002 (0.6 mm) is refused', () => {
    expect(nozzleMismatch([{ physicalId: 1, diameter: 0.4 }], liveNozzles(H2D_002)))
      .toBe('the file is sliced for a 0.4 mm nozzle but the left nozzle is 0.6 mm');
  });

  test('0.6 mm file on a 0.4 mm H2S is refused', () => {
    expect(nozzleMismatch([{ physicalId: 0, diameter: 0.6 }], liveNozzles(H2S)))
      .toBe('the file is sliced for a 0.6 mm nozzle but the nozzle is 0.4 mm');
  });

  test('a file needing the left nozzle on a single-nozzle printer is refused', () => {
    expect(nozzleMismatch([{ physicalId: 1, diameter: 0.4 }], liveNozzles(H2S))).toMatch(/does not report/);
  });

  test('"0.40" in the file equals 0.4 on the printer', () => {
    expect(nozzleMismatch([{ physicalId: 0, diameter: parseFloat('0.40') }], liveNozzles(H2S))).toBeNull();
  });

  test('unknown on either side is not a mismatch', () => {
    expect(nozzleMismatch(null, liveNozzles(H2S))).toBeNull();
    expect(nozzleMismatch([{ physicalId: 0, diameter: 0.4 }], null)).toBeNull();
  });
});
