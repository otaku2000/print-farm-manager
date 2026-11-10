// Upload over the Bambu file service on TCP 6000, which writes to a printer's internal storage.
//
// Bambu has not published this protocol. This was written from the reverse-engineering notes at
// https://github.com/ClusterM/open-bamboo-networking (research/06.04-port-6000.md and
// research/08.14-file-transfer.md) and checked against packet captures of Bambu Studio.
// Hardware status: upload and print start validated on an H2S and an H2D. One other H2D refuses
// the TLS handshake on this port, also from Bambu Studio. Other models are not validated.
//
// Wire format: implicit TLS, then frames of a 16-byte little-endian header followed by a payload.
//   bytes 0-3   payload length
//   bytes 4-7   0x3f 0x01 <subchannel> <direction: 1 = to printer, 0 = from printer>
//   bytes 8-11  per-session counter
//   bytes 12-15 zero
// Subchannel 1 carries the login, subchannel 2 carries JSON requests and file data.
// The header and payload must go out as separate writes: an H2S rejected the setup frame and
// closed the connection when they were sent together.

const tls    = require('tls');
const fs     = require('fs');
const crypto = require('crypto');

const TUNNEL_PORT = 6000;
const HEADER_SIZE = 16;
const SUBCHANNEL_LOGIN = 0x01;
const SUBCHANNEL_RPC   = 0x02;

const MTYPE_SETUP = 12291;
const MTYPE_RPC   = 12289;
const CMD_UPLOAD  = 5;
const CMD_STORAGE = 7;

const RESULT_OK         = 0;
const RESULT_CONTINUE   = 1;
const RESULT_FILE_EXIST = 19; // the printer overwrites the file, so the upload continues

const STORAGE = 'emmc';

// Must exceed the TLS handshake on a busy printer over the LAN.
const CONNECT_TIMEOUT_MS = 10000;
// Must exceed how long the printer takes to write and hash a large file before its final reply.
// Bambu's own client allows about 120 s.
const REPLY_TIMEOUT_MS = 120000;

function connect(printer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: printer.ip,
      port: TUNNEL_PORT,
      rejectUnauthorized: false,
      servername: printer.serial_number || undefined,
    });
    const fail = (err) => { clearTimeout(timer); socket.destroy(); reject(err); };
    const timer = setTimeout(() => fail(new Error('connect timed out')), timeoutMs);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

// Reassembles incoming frames and hands them out one at a time.
function frameReader(socket, timeoutMs) {
  let buffer = Buffer.alloc(0);
  let failure = null;
  const frames = [];
  const waiters = [];

  function settle() {
    while (waiters.length && (frames.length || failure)) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      if (frames.length) waiter.resolve(frames.shift());
      else waiter.reject(failure);
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= HEADER_SIZE) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < HEADER_SIZE + length) break;
      frames.push({ subchannel: buffer[6], payload: buffer.subarray(HEADER_SIZE, HEADER_SIZE + length) });
      buffer = buffer.subarray(HEADER_SIZE + length);
    }
    settle();
  });
  socket.on('error', (err) => { failure = failure || err; settle(); });
  socket.on('close', () => { failure = failure || new Error('printer closed the connection'); settle(); });

  return () => new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    waiter.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error('timed out waiting for the printer'));
    }, timeoutMs);
    waiters.push(waiter);
    settle();
  });
}

function write(socket, data) {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

function makeSender(socket) {
  let counter = crypto.randomInt(0x10000);
  return async (subchannel, payload) => {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(payload.length, 0);
    header[4] = 0x3f;
    header[5] = 0x01;
    header[6] = subchannel;
    header[7] = 0x01;
    header.writeUInt32LE(counter++, 8);
    await write(socket, header);
    if (payload.length) await write(socket, payload);
  };
}

function loginPayload(accessCode) {
  const payload = Buffer.alloc(16);
  payload.write('bblp', 0, 'ascii');
  payload.write(String(accessCode), 8, 'ascii');
  return payload;
}

// Reads frames until the JSON reply to one request arrives. Other frames are ignored.
async function readReply(nextFrame, matches) {
  for (;;) {
    const frame = await nextFrame();
    if (frame.subchannel !== SUBCHANNEL_RPC) continue;
    let reply;
    try { reply = JSON.parse(frame.payload.toString('utf8')); } catch (_) { continue; }
    if (matches(reply)) return reply;
  }
}

function rpcFrame(sequence, cmdtype, req) {
  return Buffer.from(JSON.stringify({ mtype: MTYPE_RPC, cmdtype, sequence, req }));
}

// Sends the file in chunk_size pieces, back to back. The printer only answers after the last
// one, and the notes report that waiting for an answer between chunks fails the upload.
async function sendChunks(send, handle, totalSize, sequence, chunkSize) {
  const hash = crypto.createHash('md5');
  let offset = 0;
  let fragId = 0;

  while (offset < totalSize) {
    const size = Math.min(chunkSize, totalSize - offset);
    const chunk = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(chunk, 0, size, offset);
    if (bytesRead !== size) throw new Error('file changed while uploading');
    hash.update(chunk);

    const req = { frag_id: fragId, offset, size };
    if (offset + size === totalSize) req.file_md5 = hash.digest('hex');

    await send(SUBCHANNEL_RPC, Buffer.concat([rpcFrame(sequence, CMD_UPLOAD, req), Buffer.from('\n\n'), chunk]));
    offset += size;
    fragId += 1;
  }
}

// Uploads localPath to the printer's internal storage as remoteName. Rejects on any failure.
async function uploadFile(printer, localPath, remoteName, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const replyTimeoutMs   = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;

  const { size: totalSize } = await fs.promises.stat(localPath);
  if (totalSize === 0) throw new Error('file is empty');

  const socket = await connect(printer, connectTimeoutMs);
  const handle = await fs.promises.open(localPath, 'r').catch((err) => { socket.destroy(); throw err; });

  try {
    const nextFrame = frameReader(socket, replyTimeoutMs);
    const send = makeSender(socket);

    await send(SUBCHANNEL_LOGIN, loginPayload(printer.api_key));
    const ack = await nextFrame();
    if (ack.subchannel !== SUBCHANNEL_LOGIN || ack.payload.length < 4 || ack.payload.readUInt32LE(0) !== 0) {
      throw new Error('login refused');
    }

    await send(SUBCHANNEL_RPC, Buffer.from(JSON.stringify({
      sequence: 0,
      mtype: MTYPE_SETUP,
      req: { t_av: 0, mtype: MTYPE_RPC, peer_t: 3, pid: '', ver: '' },
    })));
    const setup = await readReply(nextFrame, (r) => r.mtype === MTYPE_SETUP);
    if (setup.result !== RESULT_OK) throw new Error(`session setup failed (result ${setup.result})`);

    await send(SUBCHANNEL_RPC, rpcFrame(1, CMD_STORAGE, { peer: 'studio', api_version: 2 }));
    const storage = await readReply(nextFrame, (r) => r.cmdtype === CMD_STORAGE && r.sequence === 1);
    const targets = storage.reply?.upload_storage || storage.reply?.storage;
    if (!Array.isArray(targets) || !targets.includes(STORAGE)) {
      throw new Error(`printer does not offer ${STORAGE} storage for uploads`);
    }

    const sequence = 2;
    await send(SUBCHANNEL_RPC, rpcFrame(sequence, CMD_UPLOAD, {
      type: 'model', storage: STORAGE, path: remoteName, total: totalSize,
    }));
    const isUploadReply = (r) => r.cmdtype === CMD_UPLOAD && r.sequence === sequence;
    const init = await readReply(nextFrame, isUploadReply);
    if (init.result !== RESULT_CONTINUE && init.result !== RESULT_FILE_EXIST) {
      throw new Error(`upload refused (result ${init.result})`);
    }
    const chunkKiB = init.reply?.chunk_size;
    if (!Number.isInteger(chunkKiB) || chunkKiB <= 0) throw new Error('printer sent no chunk size');

    await sendChunks(send, handle, totalSize, sequence, chunkKiB * 1024);

    const done = await readReply(nextFrame, isUploadReply);
    if (done.result !== RESULT_OK) throw new Error(`upload failed (result ${done.result})`);
  } finally {
    await handle.close().catch(() => {});
    socket.destroy();
  }
}

module.exports = { uploadFile, STORAGE };
