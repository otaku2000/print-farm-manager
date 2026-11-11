// Unit tests for server/drivers/bambu.js
// mqtt and basic-ftp are mocked — no real network connections needed.
//
// Each test uses a unique printer ID to avoid sharing the module-level
// connection cache (Map of id → conn) between test cases.

jest.mock('mqtt');
jest.mock('basic-ftp');
jest.mock('tls');
jest.mock('../drivers/bambu-tunnel', () => ({ uploadFile: jest.fn(), STORAGE: 'emmc' }));

const { EventEmitter } = require('events');
const tls  = require('tls');
const tunnel = require('../drivers/bambu-tunnel');
const mqtt = require('mqtt');
const ftp  = require('basic-ftp');
const bambu = require('../drivers/bambu');

// ─── Mock setup ───────────────────────────────────────────────────────────────

let mockPublish;
let mockSubscribe;
let mockMqttClient;
let messageHandler; // captured from client.on('message', handler)

let mockFtpClient;

beforeEach(() => {
  messageHandler = null;

  mockPublish   = jest.fn();
  mockSubscribe = jest.fn();

  mockMqttClient = {
    // Fire 'connect' synchronously so conn.connected = true immediately.
    // Capture 'message' handler for AMS state injection in tests.
    on: jest.fn((event, handler) => {
      if (event === 'connect') handler();
      if (event === 'message') messageHandler = handler;
    }),
    publish:   mockPublish,
    subscribe: mockSubscribe,
    end:       jest.fn(),
  };
  mqtt.connect.mockReturnValue(mockMqttClient);

  mockFtpClient = {
    ftp:        { verbose: false },
    access:     jest.fn().mockResolvedValue(undefined),
    uploadFrom: jest.fn().mockResolvedValue(undefined),
    close:      jest.fn(),
  };
  ftp.Client.mockImplementation(() => mockFtpClient);
});

afterEach(() => jest.clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 300;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `Bambu_${id}`, ip: '192.168.1.50', api_key: 'TESTCODE',
           serial_number: `SN${id}`, model: 'x1c', type: 'bambu' };
}

// Establish a connection for the printer (populates the internal Map)
// then inject a status push to set conn.latestPrint.
function pushStatus(printer, printData) {
  bambu.getStatus(printer); // creates connection, registers message handler
  expect(messageHandler).not.toBeNull();
  messageHandler(null, Buffer.from(JSON.stringify({ print: printData })));
}

// Parse the MQTT payload from the first publish call that matches a command.
function findPayload(command) {
  const call = mockPublish.mock.calls.find(c => {
    try { return JSON.parse(c[1]).print?.command === command; } catch { return false; }
  });
  return call ? JSON.parse(call[1]).print : null;
}

// ─── getAmsSlots ──────────────────────────────────────────────────────────────

describe('getAmsSlots', () => {
  test('returns null when printer has no connection yet', () => {
    expect(bambu.getAmsSlots(nextPrinter())).toBeNull();
  });

  test('returns null when connected but no status received yet', () => {
    const printer = nextPrinter();
    bambu.getStatus(printer); // creates connection; latestPrint is still null
    expect(bambu.getAmsSlots(printer)).toBeNull();
  });

  test('returns loaded AMS trays, skipping empty slots', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [{
          id: '0',
          tray: [
            { id: '0' },                                             // empty — no tray_type
            { id: '1', tray_type: 'PLA', tray_color: 'FFFFFFFF' }, // loaded
          ],
        }],
      },
      vt_tray: { tray_type: 'PETG', tray_color: 'FF0000FF' },
    });

    const slots = bambu.getAmsSlots(printer);
    // AMS unit 0, tray 1 → compound slot (0*4)+1 = 1
    expect(slots).toContainEqual({ slot: 1, type: 'PLA', color: 'FFFFFFFF' });
    // Empty tray (id 0) must be excluded
    expect(slots.find(s => s.slot === 0 && s.type)).toBeUndefined();
  });

  test('always includes external spool as slot -1', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams:     { ams: [] },
      vt_tray: { tray_type: 'ABS', tray_color: '000000FF' },
    });
    expect(bambu.getAmsSlots(printer)).toContainEqual(
      { slot: -1, type: 'ABS', color: '000000FF' }
    );
  });

  test('includes external spool even when no filament is loaded', () => {
    const printer = nextPrinter();
    pushStatus(printer, { ams: { ams: [] }, vt_tray: {} });
    const ext = bambu.getAmsSlots(printer).find(s => s.slot === -1);
    expect(ext).toBeDefined();
    expect(ext.type).toBe('');
  });

  test('computes compound slot IDs for multi-unit AMS', () => {
    const printer = nextPrinter();
    pushStatus(printer, {
      ams: {
        ams: [
          { id: '0', tray: [{ id: '0', tray_type: 'PLA',  tray_color: 'FFFF00FF' }] },
          { id: '1', tray: [{ id: '2', tray_type: 'ABS',  tray_color: '000000FF' }] },
        ],
      },
      vt_tray: {},
    });
    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFF00FF' }); // (0*4)+0
    expect(slots).toContainEqual({ slot: 6, type: 'ABS', color: '000000FF' }); // (1*4)+2
  });
});

// ─── dropConnection ───────────────────────────────────────────────────────────
// The connection cache is keyed by printer.id and clients reconnect on their own
// with the credentials they were created with. dropConnection is how the routes
// layer forces a reconnect after an operator edits ip/api_key/serial_number, or
// stops the reconnect loop entirely after a delete/decommission.

describe('dropConnection', () => {
  test('ends the MQTT client with force=true', () => {
    const printer = nextPrinter();
    bambu.getStatus(printer); // creates the cached connection
    bambu.dropConnection(printer.id);
    expect(mockMqttClient.end).toHaveBeenCalledWith(true);
  });

  test('next getStatus reconnects using the credentials it is given', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'IDLE' });
    expect(mqtt.connect).toHaveBeenCalledTimes(1);

    // Same status call again: cached, no new client.
    await bambu.getStatus(printer);
    expect(mqtt.connect).toHaveBeenCalledTimes(1);

    bambu.dropConnection(printer.id);

    // Operator fixed a mistyped access code; the poller passes the updated row.
    const updated = { ...printer, api_key: 'NEWCODE1' };
    await bambu.getStatus(updated);
    expect(mqtt.connect).toHaveBeenCalledTimes(2);
    expect(mqtt.connect.mock.calls[1][1].password).toBe('NEWCODE1');
  });

  test('is a no-op for a printer with no cached connection', () => {
    expect(() => bambu.dropConnection(999999)).not.toThrow();
    expect(mockMqttClient.end).not.toHaveBeenCalled();
  });
});

// ─── getStatus — FAILED disambiguation ───────────────────────────────────────
// Bambu reports user-cancelled prints as gcode_state FAILED, same as genuine
// failures. print_error tells them apart: 50348044 = cancelled by user (resets
// to 0 a few seconds later while gcode_state stays FAILED); any other nonzero
// value = real firmware-detected failure.

describe('getStatus — FAILED: user cancel vs real failure', () => {
  test('FAILED with cancel code 50348044 maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 50348044 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with print_error 0 (settled cancel) maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 0 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with no print_error field maps to STOPPED', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED' });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with a different nonzero print_error maps to ERROR', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'FAILED', print_error: 117473285 });
    expect((await bambu.getStatus(printer)).status).toBe('ERROR');
  });

  test('RUNNING with a nonzero print_error stays PRINTING', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'RUNNING', print_error: 50348044, mc_percent: 40 });
    expect((await bambu.getStatus(printer)).status).toBe('PRINTING');
  });
});

// ─── Upload route ─────────────────────────────────────────────────────────────

describe('uploadAndPrint upload route', () => {
  function ftpError(code) {
    const err = new Error(`${code} server said no`);
    err.code = code;
    return err;
  }

  async function run(printer) {
    bambu.getStatus(printer);
    mockPublish.mockClear();
    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });
  }

  test('a successful FTPS upload does not touch port 6000', async () => {
    await run(nextPrinter());

    expect(tunnel.uploadFile).not.toHaveBeenCalled();
    const payload = findPayload('project_file');
    expect(payload.url).toBe('ftp:///1234_part.3mf');
    expect(payload.file).toBeUndefined();
    expect(payload.md5).toBeUndefined();
  });

  test('FTPS 553 falls back to port 6000 and prints from internal storage', async () => {
    const printer = nextPrinter();
    mockFtpClient.uploadFrom.mockRejectedValueOnce(ftpError(553));
    tunnel.uploadFile.mockResolvedValueOnce(undefined);

    await run(printer);

    expect(tunnel.uploadFile).toHaveBeenCalledWith(printer, '/tmp/1234_part.3mf', '1234_part.3mf');
    expect(mockFtpClient.close).toHaveBeenCalled();
    const payload = findPayload('project_file');
    expect(payload.url).toBe('brtc://emmc/1234_part.3mf');
    expect(payload.file).toBe('1234_part.3mf');
    expect(payload.md5).toBe('from_sd_card');
  });

  test('other FTPS errors fail without trying port 6000', async () => {
    mockFtpClient.uploadFrom.mockRejectedValueOnce(ftpError(522));

    await expect(run(nextPrinter())).rejects.toThrow('522');

    expect(tunnel.uploadFile).not.toHaveBeenCalled();
    expect(findPayload('project_file')).toBeNull();
  });

  test('when both routes fail no print is started and the error names both', async () => {
    mockFtpClient.uploadFrom.mockRejectedValueOnce(ftpError(553));
    tunnel.uploadFile.mockRejectedValueOnce(new Error('handshake failure'));

    await expect(run(nextPrinter())).rejects.toThrow(/553.*port 6000.*handshake failure/);

    expect(findPayload('project_file')).toBeNull();
  });
});

// ─── FTPS data connection ─────────────────────────────────────────────────────

describe('openDataConnection', () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));

  function fakeContext(message = '227 Entering Passive Mode (10,0,0,9,195,129).') {
    return {
      tlsOptions: { rejectUnauthorized: false },
      socket:     { remoteAddress: '192.168.1.50', getSession: jest.fn(() => Buffer.from('control-session')) },
      request:    jest.fn().mockResolvedValue({ code: 227, message }),
      dataSocket: undefined,
    };
  }

  function fakeSocket() {
    const socket = new EventEmitter();
    socket.destroy = jest.fn();
    tls.connect.mockReturnValue(socket);
    return socket;
  }

  test('uploadAndPrint installs it before uploading', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    let installedAtUpload;
    mockFtpClient.uploadFrom.mockImplementation(async () => { installedAtUpload = mockFtpClient.prepareTransfer; });

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(installedAtUpload).toBe(bambu.openDataConnection);
  });

  test('connects with TLS directly and reuses the control session', async () => {
    const ctx = fakeContext();
    const socket = fakeSocket();

    const pending = bambu.openDataConnection(ctx);
    await flush();
    socket.emit('connect');
    await pending;

    expect(ctx.request).toHaveBeenCalledWith('PASV');
    const options = tls.connect.mock.calls[0][0];
    expect(options.session).toEqual(Buffer.from('control-session'));
    expect(options.port).toBe(195 * 256 + 129);
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.socket).toBeUndefined();
    expect(ctx.dataSocket).toBe(socket);
  });

  test('uses the control host, not the host in the PASV reply', async () => {
    const ctx = fakeContext();
    const socket = fakeSocket();

    const pending = bambu.openDataConnection(ctx);
    await flush();
    socket.emit('connect');
    await pending;

    expect(tls.connect.mock.calls[0][0].host).toBe('192.168.1.50');
  });

  test('rejects an unreadable PASV reply without connecting', async () => {
    await expect(bambu.openDataConnection(fakeContext('500 nope'))).rejects.toThrow("Can't parse PASV");
    expect(tls.connect).not.toHaveBeenCalled();
  });

  test('a connection error rejects and leaves no data socket', async () => {
    const ctx = fakeContext();
    const socket = fakeSocket();

    const pending = bambu.openDataConnection(ctx);
    await flush();
    socket.emit('error', new Error('ECONNREFUSED'));

    await expect(pending).rejects.toThrow('ECONNREFUSED');
    expect(socket.destroy).toHaveBeenCalled();
    expect(ctx.dataSocket).toBeUndefined();
  });

  test('gives up when the connection never opens', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const ctx = fakeContext();
      const socket = fakeSocket();

      const pending = bambu.openDataConnection(ctx);
      await flush();
      jest.advanceTimersByTime(60000);

      await expect(pending).rejects.toThrow('timed out');
      expect(socket.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ─── uploadAndPrint — .3mf ────────────────────────────────────────────────────

describe('uploadAndPrint — .3mf (project_file)', () => {
  test('uses project_file MQTT command', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file')).not.toBeNull();
  });

  test('URL is ftp:///filename (per OpenBambuAPI spec)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file').url).toBe('ftp:///1234_part.3mf');
  });

  test('AMS slot 0: use_ams true, ams_mapping [0]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0]);
  });

  test('AMS slot 3: ams_mapping is [3]', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 3 });

    expect(findPayload('project_file').ams_mapping).toEqual([3]);
  });

  test('external spool (amsSlot: -1): use_ams false, ams_mapping empty array', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: -1 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([]);
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: null });

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('omitting options entirely defaults to use_ams false', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf');

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('uploads to FTP root (no ensureDir for .3mf)', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith('/tmp/1234_part.3mf', '1234_part.3mf');
  });

  test('throws when MQTT is not connected', async () => {
    const printer = nextPrinter();
    // Override: suppress 'connect' so conn.connected stays false
    mockMqttClient.on = jest.fn((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/MQTT not connected/);
  });

  test('throws when serial_number is missing', async () => {
    const printer = { ...nextPrinter(), serial_number: '' };
    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/no serial number/);
  });
});

// ─── getLoadedFilament ───────────────────────────────────────────────────────

describe('getLoadedFilament', () => {
  test('returns null before any AMS report, without opening a connection', () => {
    const printer = nextPrinter();
    mqtt.connect.mockClear();
    expect(bambu.getLoadedFilament(printer)).toBeNull();
    expect(mqtt.connect).not.toHaveBeenCalled();
  });

  test('lists every tray including empty ones, with 6-digit colors and the active tray', () => {
    const printer = nextPrinter();
    // Tray fields as an H2S reports them: a Bambu RFID spool (remain 51, sub-brand), an empty
    // tray ({id, state} only), and a third-party spool (remain -1, no sub-brand).
    pushStatus(printer, { ams: { tray_now: '3', ams: [{ id: '0', tray: [
      { id: '0', tray_type: 'PETG', tray_sub_brands: 'PETG HF', tray_color: '000000FF', remain: 51 },
      { id: '1', state: 26 },
      { id: '3', tray_type: 'PET-CF', tray_sub_brands: '', tray_color: '0c3b95ff', remain: -1 },
    ] }] } });

    expect(bambu.getLoadedFilament(printer)).toEqual({
      trays: [
        { slot: 0, ams_id: 0, slot_id: 0, type: 'PETG', name: 'PETG HF', color: '000000', remain: 51 },
        { slot: 1, ams_id: 0, slot_id: 1, type: null, name: null, color: null, remain: null },
        { slot: 3, ams_id: 0, slot_id: 3, type: 'PET-CF', name: 'PET-CF', color: '0C3B95', remain: null },
      ],
      external: null,
      active_slot: 3,
    });
  });

  test('reports the external spool and maps tray_now 254 to -1, 255 to null', () => {
    const printer = nextPrinter();
    pushStatus(printer, { vt_tray: { id: '254', tray_type: 'PLA', tray_color: 'FF6600FF' }, ams: { tray_now: '254', ams: [] } });
    expect(bambu.getLoadedFilament(printer)).toMatchObject({ external: { type: 'PLA', color: 'FF6600' }, active_slot: -1 });

    messageHandler(null, Buffer.from(JSON.stringify({ print: { ams: { tray_now: '255', ams: [] } } })));
    expect(bambu.getLoadedFilament(printer).active_slot).toBeNull();
  });
});

// ─── uploadAndPrint: AMS mapping from the sliced file ────────────────────────
// Real-world trigger: BL-H2S-004 paused with "Failed to get AMS mapping table" on a plate
// that prints with project filament 2 while its configured slot held PET-CF.

describe('uploadAndPrint: AMS mapping from the sliced file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { buildZip } = require('./helpers/build-zip');

  function servoMount3mf() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-')), '1234_servo.gcode.3mf');
    fs.writeFileSync(file, buildZip({
      'Metadata/slice_info.config':
        '<config><plate><metadata key="index" value="1"/>' +
        '<filament id="2" tray_info_idx="GFG02" type="PETG" color="#CAD1EE" used_g="11.00"/></plate></config>',
      'Metadata/project_settings.config': JSON.stringify({ filament_type: ['PETG', 'PETG'] }),
    }));
    return file;
  }

  const h2s004Ams = { ams: { ams: [{ id: '0', tray: [
    { id: '0', tray_type: 'ABS-GF', tray_color: '000000FF' },
    { id: '1', tray_type: 'PETG', tray_color: '000000FF' },
    { id: '2', tray_type: 'ABS-GF', tray_color: '0C3B95FF' },
    { id: '3', tray_type: 'PET-CF', tray_color: '000000FF' },
  ] }] } };

  test('maps the plate filament by index and moves to the tray holding its type', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'IDLE', ...h2s004Ams });
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, servoMount3mf(), 'servo.gcode.3mf', { amsSlot: 3 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([-1, 1]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 255, slot_id: 255 }, { ams_id: 0, slot_id: 1 }]);
  });

  test('regression: on a fresh connection, waits for the AMS report before choosing', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer); // connected, but no report has arrived
    mockPublish.mockClear();

    const pending = bambu.uploadAndPrint(printer, servoMount3mf(), 'servo.gcode.3mf', { amsSlot: 3, amsReportWaitMs: 5000 });
    setTimeout(() => messageHandler(null, Buffer.from(JSON.stringify({ print: { gcode_state: 'IDLE', ...h2s004Ams } }))), 50);
    await pending;

    expect(findPayload('project_file').ams_mapping).toEqual([-1, 1]);
  });

  test('match from AMS (amsSlot -2) picks the PETG tray and sends both mappings', async () => {
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'IDLE', ...h2s004Ams });
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, servoMount3mf(), 'servo.gcode.3mf', { amsSlot: -2 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([-1, 1]);
    expect(p.ams_mapping2).toEqual([{ ams_id: 255, slot_id: 255 }, { ams_id: 0, slot_id: 1 }]);
  });

  test('refuses a file sliced for another nozzle size before uploading', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-')), '1234_big.gcode.3mf');
    fs.writeFileSync(file, buildZip({
      'Metadata/slice_info.config':
        '<config><plate><metadata key="index" value="1"/>' +
        '<filament id="1" type="PETG" color="#000000"/>' +
        '<nozzle id="0" extruder_id="1" nozzle_diameter="0.6" volume_type="Standard"/></plate></config>',
      'Metadata/project_settings.config': JSON.stringify({ filament_type: ['PETG'], physical_extruder_map: ['0'] }),
    }));
    const printer = nextPrinter();
    pushStatus(printer, { gcode_state: 'IDLE', ...h2s004Ams, device: { nozzle: { info: [{ id: 0, diameter: 0.4, type: 'HS01' }] } } });
    mockPublish.mockClear();

    await expect(bambu.uploadAndPrint(printer, file, 'big.gcode.3mf', { amsSlot: -2 }))
      .rejects.toMatchObject({ code: 'NOZZLE_MISMATCH', message: expect.stringMatching(/0\.6 mm nozzle but the nozzle is 0\.4 mm/) });
    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
    expect(findPayload('project_file')).toBeNull();
    expect(bambu.nozzleMismatch(printer, file)).toMatch(/0\.6 mm/);
    expect(bambu.getNozzles(printer)).toEqual([{ id: 0, diameter: 0.4, type: 'HS01' }]);
  });

  test('refuses before uploading when no AMS report arrives', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await expect(bambu.uploadAndPrint(printer, servoMount3mf(), 'servo.gcode.3mf', { amsSlot: 3, amsReportWaitMs: 50 }))
      .rejects.toMatchObject({ code: 'AMS_UNKNOWN' });
    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
  });

  test('refuses before uploading when no tray holds the needed type', async () => {
    const printer = nextPrinter();
    const noPetg = { ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA' }, { id: '3', tray_type: 'PET-CF' }] }] } };
    pushStatus(printer, { gcode_state: 'IDLE', ...noPetg });
    mockPublish.mockClear();

    await expect(bambu.uploadAndPrint(printer, servoMount3mf(), 'servo.gcode.3mf', { amsSlot: 3 }))
      .rejects.toMatchObject({ code: 'AMS_NO_MATCH' });
    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
    expect(findPayload('project_file')).toBeNull();
  });
});

// ─── uploadAndPrint — non-.3mf rejection ─────────────────────────────────────
// Bambu printers only accept .3mf files (project_file command). Plain .gcode
// and .bgcode uploads are rejected before any FTP/MQTT activity.

describe('uploadAndPrint — non-.3mf rejection', () => {
  test('throws for .gcode with descriptive message', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('throws for .bgcode with descriptive message', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.bgcode', 'part.bgcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('does not attempt FTP upload when file is rejected', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
  });

  test('does not publish MQTT when file is rejected', async () => {
    const printer = nextPrinter();
    bambu.getStatus(printer);
    mockPublish.mockClear();

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
