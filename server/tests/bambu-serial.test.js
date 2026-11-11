// Tests for the Bambu driver's lookupSerial: the serial is the CN of the certificate the
// printer's MQTT port presents. Certificates below are as read from the farm's printers.

const { EventEmitter } = require('events');

jest.mock('mqtt', () => ({ connect: jest.fn() }));
jest.mock('tls', () => ({ connect: jest.fn() }));

const tls = require('tls');
const bambu = require('../drivers/bambu');

function fakeSocket(cert, { fail = null, silent = false } = {}) {
  tls.connect.mockImplementation((opts, onSecure) => {
    const socket = new EventEmitter();
    socket.getPeerCertificate = () => cert;
    socket.destroy = jest.fn();
    setImmediate(() => {
      if (fail) socket.emit('error', new Error(fail));
      else if (!silent) onSecure();
    });
    return socket;
  });
}

afterEach(() => tls.connect.mockReset());

test('reads the serial from an H2S certificate', async () => {
  fakeSocket({ subject: { CN: '0938AJ611400475' }, issuer: { C: 'CN', O: 'BBL Technologies Co. Ltd', CN: 'BBL Device CA O1C2-V2' } });
  await expect(bambu.lookupSerial('192.168.0.103')).resolves.toBe('0938AJ611400475');
  expect(tls.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.0.103', port: 8883 }), expect.any(Function));
});

test('reads the serial from an H2D certificate', async () => {
  fakeSocket({ subject: { CN: '0948AD5B2001764' }, issuer: { C: 'CN', O: 'BBL Technologies Co., Ltd', CN: 'BBL CA' } });
  await expect(bambu.lookupSerial('192.168.0.205')).resolves.toBe('0948AD5B2001764');
});

test('null for a TLS server that is not a Bambu printer', async () => {
  fakeSocket({ subject: { CN: 'router.local' }, issuer: { O: 'Some Router Inc' } });
  await expect(bambu.lookupSerial('192.168.0.1')).resolves.toBeNull();
  fakeSocket({ subject: { CN: 'ABCDEF123456' }, issuer: { O: 'Let\'s Encrypt' } });
  await expect(bambu.lookupSerial('192.168.0.1')).resolves.toBeNull();
});

test('null when the connection fails', async () => {
  fakeSocket(null, { fail: 'ECONNREFUSED' });
  await expect(bambu.lookupSerial('192.168.0.9')).resolves.toBeNull();
});

test('null when nothing answers before the timeout', async () => {
  fakeSocket(null, { silent: true });
  await expect(bambu.lookupSerial('192.168.0.9', 20)).resolves.toBeNull();
});
