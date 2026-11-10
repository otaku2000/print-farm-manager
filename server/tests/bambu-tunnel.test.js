// Unit tests for server/drivers/bambu-tunnel.js
// tls is mocked with a fake printer. Mocks prove the framing, not the printer.

jest.mock('tls');

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const tls    = require('tls');
const tunnel = require('../drivers/bambu-tunnel');

const printer = { id: 1, name: 'H2S', ip: '192.168.1.60', api_key: 'ABCD1234', serial_number: 'SN1' };

let tmpDir;

function tempFile(bytes) {
  const file = path.join(tmpDir, 'part.gcode.3mf');
  fs.writeFileSync(file, bytes);
  return file;
}

function replyFrame(subchannel, payload) {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(payload.length, 0);
  header[4] = 0x3f; header[5] = 0x01; header[6] = subchannel; header[7] = 0x00;
  return Buffer.concat([header, payload]);
}
const jsonFrame = (obj) => replyFrame(2, Buffer.from(JSON.stringify(obj)));

// A printer that answers each request, with overrides for the replies under test.
function fakePrinter(overrides = {}) {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.requests = [];
  socket.destroy = jest.fn();

  let pendingHeader = null;
  const answer = (buffer) => setImmediate(() => socket.emit('data', buffer));

  function onPayload(subchannel, payload) {
    if (subchannel === 1) {
      socket.login = payload;
      answer(overrides.login || replyFrame(1, Buffer.alloc(4)));
      return;
    }
    const separator = payload.indexOf('\n\n');
    const json = JSON.parse(payload.subarray(0, separator === -1 ? payload.length : separator).toString());
    const data = separator === -1 ? null : payload.subarray(separator + 2);
    socket.requests.push({ json, data });

    if (json.mtype === 12291) {
      answer(jsonFrame(overrides.setup || { mtype: 12291, sequence: 0, result: 0, reply: {} }));
    } else if (json.cmdtype === 7) {
      answer(jsonFrame(overrides.storage || { cmdtype: 7, sequence: json.sequence, result: 0, reply: { storage: ['emmc', 'udisk'], upload_storage: ['emmc', 'udisk'] } }));
    } else if (json.cmdtype === 5 && data === null) {
      answer(jsonFrame(overrides.init || { cmdtype: 5, sequence: json.sequence, result: 1, reply: { chunk_size: 255, offset: 0 } }));
    } else if (json.req.file_md5) {
      if (overrides.silentAtEnd) return;
      answer(jsonFrame(overrides.done || { cmdtype: 5, sequence: json.sequence, result: 0 }));
    }
  }

  socket.write = (buffer, callback) => {
    socket.writes.push(Buffer.from(buffer));
    if (pendingHeader) {
      const subchannel = pendingHeader[6];
      pendingHeader = null;
      onPayload(subchannel, buffer);
    } else if (buffer.length === 16) {
      pendingHeader = buffer;
    }
    setImmediate(() => callback());
    return true;
  };

  tls.connect.mockImplementation(() => {
    setImmediate(() => socket.emit('secureConnect'));
    return socket;
  });
  return socket;
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-tunnel-')); });
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe('uploadFile', () => {
  test('logs in with the access code on port 6000', async () => {
    const socket = fakePrinter();
    await tunnel.uploadFile(printer, tempFile(Buffer.alloc(100, 1)), 'part.gcode.3mf');

    const options = tls.connect.mock.calls[0][0];
    expect(options.host).toBe('192.168.1.60');
    expect(options.port).toBe(6000);
    expect(socket.login.subarray(0, 4).toString()).toBe('bblp');
    expect(socket.login.subarray(8, 16).toString()).toBe('ABCD1234');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('sends each header in its own write', async () => {
    const socket = fakePrinter();
    await tunnel.uploadFile(printer, tempFile(Buffer.alloc(100, 1)), 'part.gcode.3mf');

    const [loginHeader, loginBody, setupHeader] = socket.writes;
    expect(loginHeader.length).toBe(16);
    expect([...loginHeader.subarray(4, 8)]).toEqual([0x3f, 0x01, 0x01, 0x01]);
    expect(loginHeader.readUInt32LE(0)).toBe(16);
    expect(loginBody.length).toBe(16);
    expect(setupHeader.length).toBe(16);
    expect([...setupHeader.subarray(4, 8)]).toEqual([0x3f, 0x01, 0x02, 0x01]);
  });

  test('asks to store the file in internal storage with its size', async () => {
    const socket = fakePrinter();
    await tunnel.uploadFile(printer, tempFile(Buffer.alloc(100, 1)), 'part.gcode.3mf');

    const init = socket.requests.find(r => r.json.cmdtype === 5 && r.data === null).json;
    expect(init.req).toEqual({ type: 'model', storage: 'emmc', path: 'part.gcode.3mf', total: 100 });
  });

  test('splits the file by the chunk size and puts the md5 only on the last chunk', async () => {
    const socket = fakePrinter({ init: { cmdtype: 5, sequence: 2, result: 1, reply: { chunk_size: 1, offset: 0 } } });
    const content = crypto.randomBytes(2500);
    await tunnel.uploadFile(printer, tempFile(content), 'part.gcode.3mf');

    const chunks = socket.requests.filter(r => r.data !== null);
    expect(chunks.map(c => c.json.req.offset)).toEqual([0, 1024, 2048]);
    expect(chunks.map(c => c.json.req.frag_id)).toEqual([0, 1, 2]);
    expect(chunks.map(c => c.json.req.size)).toEqual([1024, 1024, 452]);
    expect(chunks[0].json.req.file_md5).toBeUndefined();
    expect(chunks[2].json.req.file_md5).toBe(crypto.createHash('md5').update(content).digest('hex'));
    expect(Buffer.concat(chunks.map(c => c.data)).equals(content)).toBe(true);
  });

  test('continues when the file already exists on the printer', async () => {
    const socket = fakePrinter({ init: { cmdtype: 5, sequence: 2, result: 19, reply: { chunk_size: 255, offset: 0 } } });
    await tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf');
    expect(socket.requests.some(r => r.data !== null)).toBe(true);
  });

  test('rejects when the printer refuses the upload', async () => {
    const socket = fakePrinter({ init: { cmdtype: 5, sequence: 2, result: -3 } });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf')).rejects.toThrow('upload refused (result -3)');
    expect(socket.requests.some(r => r.data !== null)).toBe(false);
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('rejects when the final reply reports a failure', async () => {
    fakePrinter({ done: { cmdtype: 5, sequence: 2, result: -9203 } });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf')).rejects.toThrow('upload failed (result -9203)');
  });

  test('rejects a refused login', async () => {
    fakePrinter({ login: replyFrame(1, Buffer.from([1, 0, 0, 0])) });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf')).rejects.toThrow('login refused');
  });

  test('rejects when the printer does not offer internal storage', async () => {
    fakePrinter({ storage: { cmdtype: 7, sequence: 1, result: 0, reply: { storage: ['udisk'] } } });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf')).rejects.toThrow('does not offer emmc');
  });

  test('rejects when the TLS connection fails', async () => {
    const socket = new EventEmitter();
    socket.destroy = jest.fn();
    tls.connect.mockImplementation(() => {
      setImmediate(() => socket.emit('error', new Error('handshake failure')));
      return socket;
    });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf')).rejects.toThrow('handshake failure');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('gives up when the printer never gives a final reply', async () => {
    const socket = fakePrinter({ silentAtEnd: true });
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf', { replyTimeoutMs: 30 })).rejects.toThrow('timed out');
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('rejects when the connection closes mid-upload', async () => {
    const socket = fakePrinter({ silentAtEnd: true });
    const pending = tunnel.uploadFile(printer, tempFile(Buffer.alloc(10, 1)), 'part.gcode.3mf');
    setTimeout(() => socket.emit('close'), 20);
    await expect(pending).rejects.toThrow('closed the connection');
  });

  test('rejects an empty file without connecting', async () => {
    await expect(tunnel.uploadFile(printer, tempFile(Buffer.alloc(0)), 'part.gcode.3mf')).rejects.toThrow('file is empty');
    expect(tls.connect).not.toHaveBeenCalled();
  });
});
