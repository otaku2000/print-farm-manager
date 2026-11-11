// Can this printer's installed nozzle print this G-code file? One answer for every caller:
// the scheduler (dispatch), the schedule projection, and the queue and dispatch-status
// diagnostics (routes/parts.js). A printer that fails it is skipped for that part, the same
// way a part whose file is missing is skipped, and falls through to the next part.
//
// Only drivers that can tell implement nozzleMismatch (Bambu: server/drivers/bambu-nozzles.js).
// Everything else, and any case where the file or the printer does not say, passes.

const path = require('path');
const { getDriver } = require('./drivers');

// Same directory and filename rule the scheduler uses to find a G-code on disk.
const GCODE_DIR = path.join(__dirname, 'gcode');

function gcodeFullPath(storedFilepath) {
  return path.join(GCODE_DIR, String(storedFilepath).split(/[\\/]/).pop());
}

// A sentence saying why the printer cannot print the file, or null.
function nozzleMismatchFor(printer, storedFilepath) {
  if (!storedFilepath) return null;
  let driver;
  try { driver = getDriver(printer.type); } catch (_) { return null; }
  if (typeof driver.nozzleMismatch !== 'function') return null;
  try {
    return driver.nozzleMismatch(printer, gcodeFullPath(storedFilepath));
  } catch (_) {
    return null;
  }
}

// The physical nozzle the file prints with (0 right, 1 left), or null when the driver cannot
// tell (non-Bambu printers, or a file that does not say).
function fileNozzleFor(printer, storedFilepath) {
  if (!storedFilepath) return null;
  let driver;
  try { driver = getDriver(printer.type); } catch (_) { return null; }
  if (typeof driver.fileNozzle !== 'function') return null;
  try {
    const n = driver.fileNozzle(gcodeFullPath(storedFilepath));
    return Number.isInteger(n) ? n : null;
  } catch (_) {
    return null;
  }
}

module.exports = { nozzleMismatchFor, fileNozzleFor, gcodeFullPath };
