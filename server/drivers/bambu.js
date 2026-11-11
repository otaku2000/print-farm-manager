// Bambu Lab printer driver — MQTT over TLS + FTPS
// Connector family: Bambu MQTT
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Prerequisites on the printer (both required):
//   Settings → Network → LAN Only Mode: ON
//   Settings → Network → Developer Mode: ON  ← appears after LAN Mode is on
//   Developer Mode eliminates the X.509 certificate signing requirement for commands.
//
// Credentials stored in DB:
//   printer.ip            — local IP address
//   printer.api_key       — access code (shown on printer screen under WiFi settings)
//   printer.serial_number — device serial number (used as MQTT topic path)
//
// Connection model (differs from Prusa/Elegoo):
//   Bambu pushes status to device/{serial}/report continuously — there is no
//   request/response polling. We subscribe once and cache the latest payload.
//   getStatus() returns from cache instantly. OFFLINE is returned until the
//   first status message arrives after connect.
//
// Bambu sends partial status updates, not full state each time.
// We merge each incoming update into conn.latestPrint so no fields are lost.
//
// Protocol reference: https://github.com/Doridian/OpenBambuAPI

const mqtt     = require('mqtt');
const ftp      = require('basic-ftp');
const path     = require('path');
const tls      = require('tls');
const tunnel   = require('./bambu-tunnel');
const ams      = require('./bambu-ams');
const nozzles  = require('./bambu-nozzles');

// FTP reply when the server cannot create the file. An H2-series printer sends it for an
// upload to its FTP root when no drive is inserted.
const FTP_CANNOT_CREATE_FILE = 553;

// How long to wait for TCP to connect on the FTPS data port. The printer is on
// the LAN, so this only has to exceed a slow printer accepting a connection
// while it is busy; the TLS handshake itself happens later, after STOR.
const FTPS_DATA_CONNECT_TIMEOUT_MS = 15000;

// Map of printer.id → { client, latestPrint, connected }
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns (or creates) the connection object for a printer.
// The MQTT connection is established in the background — callers should
// check conn.connected before sending commands.
function getOrCreateConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const serial = printer.serial_number;
  const conn   = { client: null, latestPrint: null, connected: false };
  connections.set(printer.id, conn);

  const client = mqtt.connect(`mqtts://${printer.ip}:8883`, {
    username:          'bblp',
    password:          printer.api_key, // access code from printer WiFi settings
    rejectUnauthorized: false,          // Bambu uses a self-signed TLS certificate — intentional
    reconnectPeriod:   5000,
    connectTimeout:    10000,
  });

  conn.client = client;

  client.on('connect', () => {
    conn.connected = true;

    // Subscribe to the printer's status push topic
    client.subscribe(`device/${serial}/report`, (err) => {
      if (err) console.warn(`[bambu] ${printer.name} subscribe error:`, err.message);
    });

    // Request an immediate full status dump so the cache is populated right away
    // rather than waiting for the next natural push interval.
    client.publish(`device/${serial}/request`, JSON.stringify({
      pushing: { sequence_id: '0', command: 'pushall', push_target: 1 },
    }));

    console.log(`[bambu] Connected to ${printer.name} (${printer.ip})`);
  });

  client.on('message', (_topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      // All status fields arrive under data.print.
      // Merge — Bambu sends partial updates, not a full snapshot each time.
      if (data.print) {
        conn.latestPrint = { ...conn.latestPrint, ...data.print };
      }
    } catch (_) {}
  });

  client.on('reconnect', () => {
    conn.connected = false;
    console.log(`[bambu] ${printer.name} reconnecting…`);
  });

  client.on('offline', () => {
    conn.connected = false;
  });

  client.on('error', (err) => {
    conn.connected = false;
    if (process.env.DEBUG_BAMBU) {
      console.warn(`[bambu] ${printer.name} error:`, err?.message || err);
    }
  });

  return conn;
}

// Close and forget the cached MQTT connection for a printer. The next getStatus
// call recreates it from the printer row it is given, so credential or address
// edits take effect without a server restart. Also the only way to stop the
// client's auto-reconnect loop once a printer row is deleted or decommissioned.
function dropConnection(printerId) {
  const conn = connections.get(printerId);
  if (conn) {
    try { conn.client?.end(true); } catch (_) {}
    connections.delete(printerId);
  }
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps Bambu gcode_state strings to canonical status strings.
// Source: OpenBambuAPI — https://github.com/Doridian/OpenBambuAPI
//
// RUNNING  = Active print in progress
// PREPARE  = Bed leveling, heating, homing before first layer — treat as PRINTING
// IDLE     = Standby, no print loaded
// PAUSE    = Print paused by operator or firmware event
// FINISH   = Print complete — triggers operator confirmation in farm UI
// FAILED   = Print did not complete — covers BOTH firmware-detected failures and
//            user-cancelled prints. See the print_error disambiguation in getStatus.
function mapStatus(gcodeState) {
  switch (gcodeState) {
    case 'RUNNING':  return 'PRINTING';
    case 'PREPARE':  return 'PRINTING'; // calibration/homing before layers begin
    case 'IDLE':     return 'IDLE';
    case 'PAUSE':    return 'PAUSED';
    case 'FINISH':   return 'FINISHED';
    case 'FAILED':   return 'ERROR';
    default:         return 'UNKNOWN';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Bambu reports a user-cancelled print (Stop pressed on the printer screen) as
// gcode_state FAILED — the same state as a genuine print failure — and keeps
// reporting FAILED until the next print starts or the printer power-cycles.
// The two cases are distinguished by print_error:
//   50348044 (0x0300400C) — print cancelled by the user; sent for a few seconds
//                           after the stop, then print_error resets to 0 while
//                           gcode_state stays FAILED
//   any other nonzero     — genuine firmware-detected failure
//   0                     — no active error; FAILED with no error code is a
//                           settled user cancel
// Ref: ha-bambulab pybambu/models.py (isCanceledPrint handling)
const BAMBU_USER_CANCELLED = 50348044;

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | STOPPED | ERROR | OFFLINE | UNKNOWN
// progress (0–100), timeRemaining (seconds), and currentFile are null when not printing.
async function getStatus(printer) {
  if (!printer.serial_number) {
    // Misconfigured — serial number required for MQTT topics
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const conn = getOrCreateConnection(printer);

  if (!conn.connected || !conn.latestPrint) {
    // Not yet connected or no status received — report OFFLINE, connection is
    // retrying in the background via reconnectPeriod.
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const print = conn.latestPrint;
  let status  = mapStatus(print.gcode_state);

  // User-cancelled prints report FAILED — remap to STOPPED so the scheduler
  // cancels the job (rather than failing it) and the UI doesn't show a false
  // error. Real failures carry a persistent nonzero print_error.
  if (status === 'ERROR') {
    const printError = print.print_error ?? 0;
    if (printError === 0 || printError === BAMBU_USER_CANCELLED) {
      status = 'STOPPED';
    }
  }

  const progress = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_percent ?? null)
    : null;

  // Bambu reports mc_remaining_time in minutes — convert to seconds for UI consistency.
  const timeRemaining = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_remaining_time != null ? print.mc_remaining_time * 60 : null)
    : null;

  // subtask_name is the file or project currently printing.
  // Strip the multer-prepended timestamp prefix (e.g. "1712345678901_benchy.gcode").
  const rawFilename = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.subtask_name ?? null)
    : null;
  const currentFile = rawFilename ? rawFilename.replace(/^\d+_/, '') : null;

  return { status, progress, timeRemaining, currentFile };
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Returns the current AMS slot list from the cached MQTT state, or null if not connected.
// Each slot: { slot, type, color }
//   slot  — compound id: (ams_unit * 4) + tray_id, or -1 for external spool
//   type  — filament type string e.g. 'PLA', or '' if unknown
//   color — RRGGBBAA hex string, or null
// Empty trays (no tray_type field) are omitted. External spool is always included.
function getAmsSlots(printer) {
  const conn = connections.get(printer.id);
  if (!conn?.latestPrint) return null;

  const slots = [];

  const amsUnits = conn.latestPrint.ams?.ams || [];
  for (const unit of amsUnits) {
    const amsId = parseInt(unit.id, 10);
    for (const tray of unit.tray || []) {
      if (!tray.tray_type) continue; // empty slot — no filament loaded
      slots.push({
        slot:  amsId * 4 + parseInt(tray.id, 10),
        type:  tray.tray_type,
        color: tray.tray_color || null,
      });
    }
  }

  // External spool is always an option regardless of whether filament is loaded
  const vt = conn.latestPrint.vt_tray;
  slots.push({
    slot:  -1,
    type:  vt?.tray_type || '',
    color: vt?.tray_color || null,
  });

  return slots;
}

// How long a dispatch waits for a printer's first AMS report. Must exceed an MQTT connect
// (10 s connectTimeout above) plus the reply to the pushall sent on connect.
const AMS_REPORT_WAIT_MS = 20000;
const AMS_REPORT_POLL_MS = 250;

// Resolves once the cached report satisfies `ready`, or after timeoutMs (the caller's check
// then decides what an absent report means).
async function waitForReport(conn, ready, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!ready(conn.latestPrint) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, AMS_REPORT_POLL_MS));
  }
}

// Resolves once the connection has an AMS report, or after timeoutMs (the caller's mapping
// step then refuses the dispatch).
function waitForAmsReport(conn, timeoutMs) {
  return waitForReport(conn, r => Array.isArray(r?.ams?.ams), timeoutMs);
}

// Installed nozzles from the cached report: [{ id, diameter, type }] (id 0 is the right
// nozzle on a two-nozzle printer, see bambu-nozzles.js), or null before the first report.
// Never opens a connection.
function getNozzles(printer) {
  return nozzles.liveNozzles(connections.get(printer.id)?.latestPrint);
}

// Why this printer cannot print this file because of its nozzle, or null when it can or
// either side is unknown. Synchronous and cached per file, so the scheduler can call it
// while choosing work. Never opens a connection.
function nozzleMismatch(printer, gcodeFullPath) {
  return nozzles.nozzleMismatch(nozzles.readPlateNozzles(gcodeFullPath), getNozzles(printer));
}

// Live loaded filament for display, from the cached MQTT report. Never opens a connection.
// Returns null until the printer has reported its AMS. Shape:
//   trays        every AMS tray, empty ones included:
//                { slot, ams_id, slot_id, type, name, color, remain }
//                slot is the compound id (ams_id * 4 + slot_id); type is the generic
//                tray_type ("PETG") and name the product (tray_sub_brands, "PETG HF"),
//                falling back to type for spools without one; both null when empty;
//                color is RRGGBB or null; remain is percent left (0 to 100), or null when
//                the printer does not know. Read from live H2S/H2D reports: remain is
//                -1 for a spool without a Bambu RFID tag.
//   external     the external spool { type, color } when one is loaded, else null
//   active_slot  tray currently feeding (tray_now): a slot, -1 for the external spool,
//                null when none (OpenBambuAPI: 254 = external, 255 = none)
function getLoadedFilament(printer) {
  const conn = connections.get(printer.id);
  const trays = ams.liveTrays(conn?.latestPrint);
  if (!trays) return null;

  const report = conn.latestPrint;
  const vt = report.vt_tray;
  const trayNow = parseInt(report.ams?.tray_now, 10);
  let activeSlot = null;
  if (trayNow === 254) activeSlot = -1;
  else if (Number.isInteger(trayNow) && trayNow >= 0 && trayNow < 254) activeSlot = trayNow;

  return {
    trays: trays.map(t => ({
      slot: t.tray, ams_id: t.amsId, slot_id: t.slotId,
      type: t.type || null,
      name: t.type ? (t.subBrand || t.type) : null,
      color: t.type ? t.color : null,
      remain: t.type && Number.isInteger(t.remain) && t.remain >= 0 && t.remain <= 100 ? t.remain : null,
    })),
    external: vt?.tray_type ? { type: vt.tray_type, color: vt.tray_color ? String(vt.tray_color).slice(0, 6).toUpperCase() : null } : null,
    active_slot: activeSlot,
  };
}

// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot: -1 or null = external spool, 0 to N = a fixed AMS tray (checked against
// the sliced file's filament), -2 = match a tray from the AMS by that filament (bambu-ams.js)
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null } = options;
  if (!printer.serial_number) {
    throw new Error(`Bambu printer ${printer.name} has no serial number configured`);
  }

  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();

  // Bambu printers only support .3mf files via the project_file MQTT command.
  // The gcode_file command is non-functional on A-series (A1, A2, A2L) and
  // wrapping a plain gcode in a minimal .3mf does not satisfy firmware validation.
  // Operators must export .3mf from Bambu Studio or Orca Slicer.
  if (ext !== '.3mf') {
    throw new Error(
      `Bambu printer ${printer.name} requires a .3mf file. ` +
      `Export from Bambu Studio or Orca Slicer instead of uploading a plain .gcode.`
    );
  }

  // Resolve the AMS mapping before uploading, so a printer without the filament the plate
  // needs is refused without a wasted transfer. Layout and sources: bambu-ams.js.
  // A dispatch right after recommission arrives on a brand new MQTT connection that has not
  // received its first report yet, so wait for the AMS contents instead of guessing.
  const conn = getOrCreateConnection(printer);
  const plate = ams.readPlateFilaments(gcodeFullPath);
  if (ams.needsAmsReport(amsSlot, plate)) {
    await waitForAmsReport(conn, options.amsReportWaitMs ?? AMS_REPORT_WAIT_MS);
  }
  const mapping = ams.buildAmsMapping({
    printerName: printer.name,
    amsSlot,
    plate,
    latestPrint: conn.latestPrint,
  });
  if (mapping.note) console.log(`[bambu] ${printer.name}: ${mapping.note}`);

  // Refuse a file sliced for a different nozzle size than the nozzle it would print on
  // (bambu-nozzles.js). The scheduler skips such printers already; this is the last check,
  // made after waiting for the first report on a new connection.
  const requiredNozzles = nozzles.readPlateNozzles(gcodeFullPath);
  if (requiredNozzles && !nozzles.liveNozzles(conn.latestPrint)) {
    await waitForReport(conn, r => !!nozzles.liveNozzles(r), options.amsReportWaitMs ?? AMS_REPORT_WAIT_MS);
  }
  const installedNozzles = nozzles.liveNozzles(conn.latestPrint);
  const nozzleProblem = nozzles.nozzleMismatch(requiredNozzles, installedNozzles);
  if (nozzleProblem) {
    const err = new Error(`${printer.name}: ${nozzleProblem}`);
    err.code = 'NOZZLE_MISMATCH';
    throw err;
  }
  if (requiredNozzles && !installedNozzles) {
    console.warn(`[bambu] ${printer.name} has not reported its nozzles, so the nozzle size was not checked`);
  }

  const usedInternalStorage = await uploadToPrinter(printer, gcodeFullPath, onPrinterFilename);

  // ── MQTT print trigger ───────────────────────────────────────────────────
  if (!conn.connected) {
    throw new Error(`Bambu printer ${printer.name} MQTT not connected — cannot trigger print`);
  }

  const subtaskName = path.basename(onPrinterFilename, '.3mf');
  const printPayload = {
    sequence_id:     '0',
    command:         'project_file',
    param:           'Metadata/plate_1.gcode',
    subtask_name:    subtaskName,
    url:             usedInternalStorage
      ? `brtc://${tunnel.STORAGE}/${onPrinterFilename}`
      : `ftp:///${onPrinterFilename}`,
    ...(usedInternalStorage ? { file: onPrinterFilename, md5: 'from_sd_card' } : {}),
    bed_type:        'auto',
    timelapse:       false,
    bed_leveling:    true,
    flow_cali:       false,
    vibration_cali:  true,
    layer_inspect:   false,
    use_ams:         mapping.useAms,
    ams_mapping:     mapping.amsMapping,
    ...(mapping.amsMapping2 ? { ams_mapping2: mapping.amsMapping2 } : {}),
    profile_id:      '0',
    project_id:      '0',
    subtask_id:      '0',
    task_id:         '0',
  };

  const mqttPayload = JSON.stringify({ print: printPayload });
  console.log(`[bambu] MQTT payload → ${printer.name}: ${mqttPayload}`);
  conn.client.publish(`device/${printer.serial_number}/request`, mqttPayload, (err) => {
    if (err) console.error(`[bambu] MQTT publish failed for ${printer.name}:`, err.message);
    else console.log(`[bambu] MQTT publish confirmed for ${printer.name}`);
  });
}

// ─── Upload ───────────────────────────────────────────────────────────────────

// Tries FTPS first, which writes to the SD card or USB drive. An H2-series printer with no
// drive refuses that with 553, and then the file goes to internal storage over port 6000.
// Bambu Studio falls back in the same order. Returns true when internal storage was used.
async function uploadToPrinter(printer, gcodeFullPath, onPrinterFilename) {
  console.log(`[bambu] Uploading ${onPrinterFilename} to ${printer.name} via FTPS…`);

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    ftpClient.prepareTransfer = openDataConnection;
    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);
    console.log(`[bambu] Upload complete on ${printer.name}`);
    return false;
  } catch (err) {
    if (err.code !== FTP_CANNOT_CREATE_FILE) throw err;
  } finally {
    ftpClient.close();
  }

  console.log(`[bambu] ${printer.name} has no writable FTPS storage, uploading to internal storage on port 6000…`);
  try {
    await tunnel.uploadFile(printer, gcodeFullPath, onPrinterFilename);
  } catch (err) {
    throw new Error(
      `Bambu printer ${printer.name} refused the FTPS upload (553, no drive?) and the port 6000 upload failed: ${err.message}`
    );
  }
  console.log(`[bambu] Upload complete on ${printer.name} (internal storage)`);
  return true;
}

// ─── FTPS data connection ─────────────────────────────────────────────────────

// Replaces basic-ftp's passive-mode setup for uploads.
//
// The printer's FTP server (vsftpd) rejects a data connection that does not
// resume the control connection's TLS session: "522 SSL connection failed:
// session reuse required". basic-ftp opens a plain socket and wraps it in TLS,
// and on Node 22 that wrapped socket does not offer the session, so the upload
// fails after the server has already created an empty file. Opening the data
// connection with tls.connect directly does offer it. Observed on an H2D with
// a packet capture and a side-by-side test of both methods.
//
// The handshake is not awaited here: the server only starts TLS on this socket
// after it receives STOR, and basic-ftp waits for secureConnect before sending
// file data.
async function openDataConnection(ftpContext) {
  const res = await ftpContext.request('PASV');
  const fields = res.message.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
  if (!fields) throw new Error(`Can't parse PASV response: ${res.message}`);
  const port = parseInt(fields[5], 10) * 256 + parseInt(fields[6], 10);

  await new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...ftpContext.tlsOptions,
      host:    ftpContext.socket.remoteAddress, // same host as the control connection
      port,
      session: ftpContext.socket.getSession(),
    });
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Can't open FTPS data connection: ${err.message}`));
    };
    const timer = setTimeout(() => fail(new Error('connect timed out')), FTPS_DATA_CONNECT_TIMEOUT_MS);
    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      ftpContext.dataSocket = socket; // basic-ftp attaches its own error handlers here
      resolve();
    });
  });

  return res;
}

// ─── File cleanup ─────────────────────────────────────────────────────────────

// Deletes a file from the printer's SD card via FTPS.
// Called by the scheduler after a job finishes to prevent accumulation of files.
async function deleteFile(printer, filename) {
  if (!filename) return;

  // All Bambu uploads are .3mf files at the SD card root.
  const remotePath = filename;

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.remove(remotePath);
    console.log(`[bambu] Deleted ${remotePath} from ${printer.name}`);
  } catch (err) {
    // Non-fatal — file may have already been deleted or never uploaded
    console.warn(`[bambu] Could not delete ${filename} from ${printer.name}: ${err.message}`);
  } finally {
    ftpClient.close();
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  if (!printer.serial_number) return;

  const conn = connections.get(printer.id);
  if (!conn?.connected) {
    console.warn(`[bambu] ${printer.name} not connected — cannot cancel`);
    return;
  }

  conn.client.publish(`device/${printer.serial_number}/request`, JSON.stringify({
    print: { sequence_id: '0', command: 'stop' },
  }));

  console.log(`[bambu] Job cancelled on ${printer.name}`);
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
async function checkIfPrinting(printer) {
  const { status } = await getStatus(printer);
  return status === 'PRINTING' || status === 'PAUSED';
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getAmsSlots, getLoadedFilament, getNozzles, nozzleMismatch, deleteFile, dropConnection, openDataConnection };
