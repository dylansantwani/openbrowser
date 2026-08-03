/**
 * Minimal RFC 6455 WebSocket server + client.
 *
 * Hand-rolled on purpose. The whole point of this project is that you can clone
 * the repo, point an MCP client at `node mcp-server/src/index.js`, and have it
 * work. `npm install` is the most common reason that doesn't happen, so there
 * are no dependencies anywhere in this package.
 *
 * Supports what we actually need: text + binary frames, continuation frames,
 * ping/pong, the close handshake, and client-side masking. No permessage-deflate,
 * no extension negotiation.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Screenshots are the big payloads; 256 MB is a generous ceiling. */
const MAX_FRAME = 268_435_456;

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * A socket that has already completed the WebSocket handshake.
 * Emits: 'message' (string | Buffer), 'close', 'error'.
 */
export class WebSocketConnection extends EventEmitter {
  /** @param {net.Socket} socket @param {{isClient?: boolean}} [opts] */
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.isClient = !!opts.isClient; // client -> server frames must be masked
    this.closed = false;
    /** Arbitrary metadata slot — the hub stashes role/id here. */
    this.meta = {};

    this._buf = Buffer.alloc(0);
    this._frag = null; // accumulator for fragmented messages

    socket.on('data', (chunk) => {
      try {
        this._onData(chunk);
      } catch (err) {
        this.emit('error', err);
        this.close(1002, 'protocol error');
      }
    });
    socket.on('close', () => this._finish());
    socket.on('error', (err) => {
      // A peer disappearing is normal (tab closed, browser quit). Surface it,
      // but never let it become an unhandled 'error' event.
      this.emit('error', err);
      this._finish();
    });

    // Keep proxies and NAT tables from silently dropping an idle session.
    this._pingTimer = setInterval(() => {
      if (!this.closed) this._send(OP.PING, Buffer.alloc(0));
    }, 30_000);
    this._pingTimer.unref?.();
  }

  send(data) {
    if (this.closed) return false;
    if (typeof data === 'string') this._send(OP.TEXT, Buffer.from(data, 'utf8'));
    else this._send(OP.BINARY, Buffer.from(data));
    return true;
  }

  sendJSON(obj) {
    return this.send(JSON.stringify(obj));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._send(OP.CLOSE, payload);
    this._finish();
    // Let the close frame flush before tearing the socket down.
    setTimeout(() => this.socket.destroy(), 50).unref?.();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._pingTimer);
    this.emit('close');
  }

  _send(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;

    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode

    if (!this.isClient) {
      this.socket.write(Buffer.concat([header, payload]));
      return;
    }

    header[1] |= 0x80;
    const key = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
    this.socket.write(Buffer.concat([header, key, masked]));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // Frames arrive coalesced or split across TCP reads. Drain every complete
    // frame, then keep the remainder for the next read.
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  /** @returns {{fin: boolean, opcode: number, payload: Buffer} | null} */
  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME)) throw new Error('websocket frame too large');
      len = Number(big);
      offset += 8;
    }

    let key = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      key = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (key) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ key[i & 3];
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }

    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this._send(OP.PONG, payload);
        return;
      case OP.PONG:
        return;
      case OP.CLOSE:
        this._finish();
        this.socket.destroy();
        return;
      case OP.CONT: {
        if (!this._frag) return; // stray continuation
        this._frag.chunks.push(payload);
        if (fin) {
          const { opcode: first, chunks } = this._frag;
          this._frag = null;
          this._emitMessage(first, Buffer.concat(chunks));
        }
        return;
      }
      case OP.TEXT:
      case OP.BINARY: {
        if (!fin) {
          this._frag = { opcode, chunks: [payload] };
          return;
        }
        this._emitMessage(opcode, payload);
        return;
      }
      default:
        this.close(1002, 'unknown opcode');
    }
  }

  _emitMessage(opcode, payload) {
    this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload);
  }
}

/**
 * WebSocket server bound to host/port. Emits 'connection' (conn, req).
 * Also answers `GET /health` over plain HTTP so tooling can detect a running
 * hub without speaking WebSocket.
 */
export class WebSocketServer extends EventEmitter {
  constructor({ port, host = '127.0.0.1', healthPayload = () => ({ ok: true }) }) {
    super();
    this.port = port;
    this.host = host;
    this.healthPayload = healthPayload;
    this.connections = new Set();

    this.http = createServer((req, res) => {
      if (req.method === 'GET' && (req.url || '').startsWith('/health')) {
        const body = JSON.stringify(this.healthPayload());
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });

    // `head` is any data Node read past the end of the upgrade request — a
    // client that sends its first frame immediately ends up here.
    this.http.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.http.once('error', onError);
      this.http.listen(this.port, this.host, () => {
        this.http.removeListener('error', onError);
        // Past the initial bind, errors are per-connection noise, not fatal.
        this.http.on('error', (err) => this.emit('error', err));
        resolve(this);
      });
    });
  }

  close() {
    for (const c of this.connections) c.close(1001, 'server shutting down');
    return new Promise((resolve) => this.http.close(resolve));
  }

  _upgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }

    // We only ever bind loopback, so the extension's chrome-extension:// origin
    // is informational rather than a security control.
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = new WebSocketConnection(socket, { isClient: false });
    conn.path = (req.url || '/').split('?')[0];
    conn.query = new URL(req.url || '/', 'http://localhost').searchParams;
    this.connections.add(conn);
    conn.on('close', () => this.connections.delete(conn));
    conn.on('error', () => {});

    this.emit('connection', conn, req);

    // After the handler has had its chance to attach listeners.
    if (head?.length) deliverWhenListening(conn, head);
  }
}

/**
 * Connect to a WebSocket server. Resolves once the handshake completes.
 * @returns {Promise<WebSocketConnection>}
 */
export function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const port = Number(u.port) || 80;
    const socket = net.connect(port, u.hostname);
    const key = randomBytes(16).toString('base64');
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(5000, () => fail(new Error('websocket handshake timed out')));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1\r\n` +
          `Host: ${u.hostname}:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    let head = Buffer.alloc(0);
    const onHandshakeData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;

      const header = head.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 101/.test(header)) {
        fail(new Error(`websocket upgrade rejected: ${header.split('\r\n')[0]}`));
        return;
      }
      if (/sec-websocket-accept:\s*(\S+)/i.exec(header)?.[1] !== acceptKey(key)) {
        fail(new Error('websocket accept key mismatch'));
        return;
      }

      settled = true;
      socket.setTimeout(0);
      socket.removeListener('data', onHandshakeData);
      socket.removeListener('error', fail);
      socket.setNoDelay(true);

      const conn = new WebSocketConnection(socket, { isClient: true });
      conn.on('error', () => {});

      // Bytes after the handshake response are already the first frame. A
      // server that greets on connect (ours does) writes that frame in the same
      // tick as the 101, so TCP coalesces them and they land here. Emitting them
      // now would fire 'message' before the caller — who is still blocked on
      // this promise — has attached a listener, silently dropping the greeting.
      // So hold them until a listener exists.
      const rest = head.subarray(end + 4);
      if (rest.length) deliverWhenListening(conn, rest);

      resolve(conn);
    };
    socket.on('data', onHandshakeData);
  });
}

/**
 * Feed already-buffered bytes to a connection, but not before something is
 * listening for the resulting messages.
 *
 * Used for the bytes that arrive alongside a handshake, on both the client and
 * server side. Without it, a peer that speaks first races the caller's
 * `.on('message')` and its opening frame is lost — which shows up as an
 * intermittent, timing-dependent failure rather than an obvious one.
 */
function deliverWhenListening(conn, bytes) {
  const flush = () => conn._onData(bytes);

  if (conn.listenerCount('message') > 0) {
    flush();
    return;
  }

  const onNewListener = (event) => {
    if (event !== 'message') return;
    conn.removeListener('newListener', onNewListener);
    // 'newListener' fires *before* the listener is registered, so let the
    // current call finish first.
    queueMicrotask(flush);
  };
  conn.on('newListener', onNewListener);
}
