/**
 * The hub is the meeting point between MCP clients and the browser extension.
 *
 * Topology:
 *
 *   opencode  ──stdio──> mcp-server ─┐
 *                                    ├─ws─> hub (:8848) <─ws─ Chrome extension
 *   Claude Code ─stdio──> mcp-server ┘
 *
 * Exactly one process owns the hub port. Whoever starts first binds it; anyone
 * starting later detects the port is taken and joins as a secondary client over
 * `/mcp`. That means you can run the same server from several MCP clients at
 * once and they all share one browser, which is the normal case once you have
 * both an editor agent and a CLI agent running.
 */

import { WebSocketServer, connectWebSocket } from './ws.js';

export const DEFAULT_PORT = 8848;

/**
 * Names for concurrent sessions, in the order they are handed out.
 *
 * This is what a human reads in the tab strip, so it is worth getting right:
 * "claude · harbor" tells you which job a tab belongs to at a glance, while
 * "claude 8cac" is four characters of hex nobody can hold in their head or say
 * out loud. Short, common, visually distinct words — no two starting with the
 * same letter, so they stay separable even truncated in a narrow tab group.
 */
const SESSION_NAMES = [
  'harbor', 'meadow', 'falcon', 'copper', 'lantern', 'willow',
  'basalt', 'ember', 'quarry', 'thistle', 'juniper', 'saffron',
  'orchard', 'pelican', 'granite', 'nutmeg',
];

/** How long a single browser call may take before we give up on it. */
const CALL_TIMEOUT_MS = 120_000;

let seq = 0;
const nextId = () => `c${++seq}`;

class PendingCalls {
  constructor() {
    this.map = new Map();
  }

  create(id, { timeout = CALL_TIMEOUT_MS, onTimeout } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        onTimeout?.();
        reject(new Error(`browser call timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      this.map.set(id, { resolve, reject, timer });
    });
  }

  settle(id, ok, payload) {
    const entry = this.map.get(id);
    if (!entry) return; // already timed out
    clearTimeout(entry.timer);
    this.map.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(Object.assign(new Error(payload?.message || 'browser call failed'), payload));
  }

  rejectAll(reason) {
    for (const [id, entry] of this.map) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.map.delete(id);
    }
  }
}

/**
 * Hub owner: binds the port, holds the extension connection, and fans calls in
 * from both local (in-process) and remote (secondary MCP server) callers.
 */
export class Hub {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', log = () => {} } = {}) {
    this.port = port;
    this.host = host;
    this.log = log;

    /** @type {import('./ws.js').WebSocketConnection | null} */
    this.extension = null;
    this.extensionInfo = null;
    this.pending = new PendingCalls();
    /** Secondary MCP servers connected over /mcp. */
    this.peers = new Set();
    /** Resolvers waiting for an extension to show up. */
    this._waiters = [];

    /**
     * Session names currently in use. Handing these out centrally is what makes
     * them safe: two sessions sharing a name would share a tab group and drive
     * each other's tabs.
     */
    this.takenNames = new Set();
    this.sessionName = this._claimName();
  }

  /** A readable name no other live session is using. */
  _claimName() {
    for (const word of SESSION_NAMES) {
      if (!this.takenNames.has(word)) {
        this.takenNames.add(word);
        return word;
      }
    }
    // More concurrent sessions than names. Numbered names are ugly but unique,
    // which is the property that actually matters.
    for (let n = 2; ; n++) {
      const name = `session-${n}`;
      if (!this.takenNames.has(name)) {
        this.takenNames.add(name);
        return name;
      }
    }
  }

  async start() {
    this.server = new WebSocketServer({
      port: this.port,
      host: this.host,
      healthPayload: () => ({
        ok: true,
        role: 'hub',
        extensionConnected: !!this.extension,
        browser: this.extensionInfo?.browser ?? null,
        peers: this.peers.size,
      }),
    });

    this.server.on('connection', (conn) => this._onConnection(conn));
    await this.server.listen();
    this.log(`hub listening on ws://${this.host}:${this.port}`);
    return this;
  }

  _onConnection(conn) {
    // `/ext` is the extension; `/mcp` is another mcp-server process joining.
    const role = conn.path === '/mcp' ? 'peer' : 'extension';

    if (role === 'peer') {
      this.peers.add(conn);
      // The name is assigned here, not chosen by the peer, so it is unique
      // among everything currently connected.
      const name = this._claimName();
      conn.sessionName = name;

      conn.on('close', () => {
        this.peers.delete(conn);
        // The name is deliberately *not* released. A finished session can leave
        // its tab group behind — cleanup only closes tabs it opened, not ones
        // it adopted — and handing the same name to the next session would drop
        // it straight into those leftover tabs. Names are cheap; collisions are
        // not.
        this._endSession(conn.sessionLabel || name);
      });
      conn.on('message', (raw) => this._onPeerMessage(conn, raw));
      conn.sendJSON({
        type: 'hello',
        role: 'hub',
        extensionConnected: !!this.extension,
        sessionName: name,
      });
      return;
    }

    // Only one extension at a time. A reconnect (extension reloaded, service
    // worker respawned) supersedes the old connection.
    if (this.extension && !this.extension.closed) {
      this.log('extension reconnected; dropping previous connection');
      this.extension.close(1000, 'superseded');
    }

    this.extension = conn;
    conn.on('message', (raw) => this._onExtensionMessage(raw));
    conn.on('close', () => {
      if (this.extension === conn) {
        this.extension = null;
        this.extensionInfo = null;
        this.pending.rejectAll('browser extension disconnected mid-call');
        this._broadcastPeers({ type: 'extension_status', connected: false });
        this.log('extension disconnected');
      }
    });
    conn.sendJSON({ type: 'hello', role: 'hub' });
  }

  _onExtensionMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      this.extensionInfo = msg;
      this.log(`extension connected (${msg.browser || 'chrome'} v${msg.version || '?'})`);
      this._broadcastPeers({ type: 'extension_status', connected: true, info: msg });
      const waiters = this._waiters.splice(0);
      for (const resolve of waiters) resolve();
      return;
    }

    if (msg.type === 'result') {
      // Results for a peer's call are relayed back to that peer verbatim.
      const owner = this._callOwners?.get(msg.id);
      if (owner) {
        this._callOwners.delete(msg.id);
        if (!owner.closed) owner.sendJSON(msg);
        return;
      }
      this.pending.settle(msg.id, msg.ok, msg.ok ? msg.result : msg.error);
    }
  }

  _onPeerMessage(peer, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // The hub allocates the unique half of a name, but only the peer knows the
    // MCP client's own name, so the label that actually appears on the tab
    // group is composed there and registered back here. Without it, cleanup on
    // disconnect would look for a workstream that does not exist.
    if (msg.type === 'register') {
      peer.sessionLabel = msg.label;
      return;
    }

    if (msg.type !== 'call') return;

    if (!this.extension || this.extension.closed) {
      peer.sendJSON({ type: 'result', id: msg.id, ok: false, error: { message: NO_EXTENSION } });
      return;
    }
    this._callOwners ??= new Map();
    this._callOwners.set(msg.id, peer);
    this.extension.sendJSON(msg);
  }

  _broadcastPeers(obj) {
    for (const p of this.peers) if (!p.closed) p.sendJSON(obj);
  }

  /**
   * Tell the browser a session is finished, so it can tidy the tabs that
   * session opened.
   *
   * A disconnected MCP client is the only reliable "the task is over" signal
   * available — an agent can stop mid-plan and never say so. Fire-and-forget:
   * nobody is waiting on the result, and failing to tidy up must never be
   * allowed to hold a shutdown open.
   */
  _endSession(name) {
    if (!name || !this.extension || this.extension.closed) return;
    this.extension.sendJSON({
      type: 'call',
      id: `session-end-${name}-${this.peers.size}`,
      tool: '__session_end',
      args: { _session: name },
    });
  }

  get connected() {
    return !!this.extension && !this.extension.closed;
  }

  /** Resolve once an extension is connected, or reject after `timeout`. */
  waitForExtension(timeout = 20_000) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== resolve);
        reject(new Error(NO_EXTENSION));
      }, timeout);
      timer.unref?.();
      this._waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Invoke a tool in the browser. @returns {Promise<any>} */
  async call(tool, args = {}, { timeout } = {}) {
    if (!this.connected) await this.waitForExtension();
    const id = nextId();
    const promise = this.pending.create(id, { timeout });
    this.extension.sendJSON({ type: 'call', id, tool, args });
    return promise;
  }

  /** Record the label this session's tab group actually carries. */
  setSessionLabel(label) {
    this.sessionLabel = label;
  }

  async stop() {
    this.pending.rejectAll('hub shutting down');
    // A peer's cleanup is triggered by its socket closing; the hub owner has no
    // socket to close, so it has to say so on the way out. The short wait is
    // for the frame to reach the extension before the server is torn down.
    this._endSession(this.sessionLabel || this.sessionName);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.server?.close();
  }
}

/**
 * Secondary role: another process already owns the hub port, so we proxy every
 * call through it. Presents the same `call()` surface as Hub, so callers do not
 * care which role they got.
 */
export class HubClient {
  constructor({ port = DEFAULT_PORT, host = '127.0.0.1', log = () => {} } = {}) {
    this.url = `ws://${host}:${port}/mcp`;
    this.log = log;
    this.pending = new PendingCalls();
    this.conn = null;
    this.extensionConnected = false;
    this._waiters = [];
  }

  async start() {
    await this._connect();
    return this;
  }

  async _connect() {
    this.conn = await connectWebSocket(this.url);
    this.log(`joined existing hub at ${this.url}`);

    // The hub sends a hello carrying the current browser status immediately.
    // Waiting for it here means `connected` is accurate the moment start()
    // resolves — otherwise the first tool call races the hello and can report
    // "no browser" while one is in fact attached.
    const helloSeen = new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000); // hub is loopback; this is generous
      timer.unref?.();
      this._onHello = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    this.conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'hello' || msg.type === 'extension_status') {
        // The hub owns name allocation; a joining server is told which one it
        // got, so two servers can never end up driving the same tab group.
        if (msg.sessionName) this.sessionName = msg.sessionName;
        this.extensionConnected = !!(msg.connected ?? msg.extensionConnected);
        this._onHello?.();
        this._onHello = null;
        if (this.extensionConnected) {
          for (const w of this._waiters.splice(0)) w();
        }
        return;
      }
      if (msg.type === 'result') {
        this.pending.settle(msg.id, msg.ok, msg.ok ? msg.result : msg.error);
      }
    });

    this.conn.on('close', () => {
      this.extensionConnected = false;
      this.pending.rejectAll('hub connection lost');
      // The hub owner may have exited; retry so we can take over or rejoin.
      setTimeout(() => this._connect().catch(() => {}), 1000).unref?.();
    });

    await helloSeen;
  }

  get connected() {
    return this.extensionConnected;
  }

  waitForExtension(timeout = 20_000) {
    if (this.extensionConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(NO_EXTENSION)), timeout);
      timer.unref?.();
      this._waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async call(tool, args = {}, { timeout } = {}) {
    if (!this.conn || this.conn.closed) await this._connect();
    const id = nextId();
    const promise = this.pending.create(id, { timeout });
    this.conn.sendJSON({ type: 'call', id, tool, args });
    return promise;
  }

  setSessionLabel(label) {
    this.sessionLabel = label;
    if (this.conn && !this.conn.closed) this.conn.sendJSON({ type: 'register', label });
  }

  async stop() {
    this.pending.rejectAll('shutting down');
    this.conn?.close();
  }
}

export const NO_EXTENSION =
  'No browser connected. Open Chrome, make sure the OpenBrowser extension is installed and enabled, ' +
  'and check that its port matches this server (default 8848). The extension reconnects automatically.';

/**
 * Bind the hub if the port is free, otherwise join the existing one.
 * @returns {Promise<Hub | HubClient>}
 */
export async function createTransport(opts = {}) {
  const hub = new Hub(opts);
  try {
    await hub.start();
    return hub;
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    opts.log?.('hub port busy — joining the existing hub');
    return new HubClient(opts).start();
  }
}
