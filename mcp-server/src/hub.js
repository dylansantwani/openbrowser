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
     *
     * This set is process memory, and a hub owner is an ordinary MCP server
     * that can be killed at any time. So it is seeded from the browser on
     * connect — see `_seedTakenNames` — and topped up by every peer that
     * re-registers a label it is already using.
     */
    this.takenNames = new Set();

    /**
     * True once the browser has told us which names are already spoken for.
     * Until then no name is handed out, because handing one out early is
     * exactly how a restarted hub drops a fresh session into a dead one's tabs.
     */
    this._seeded = false;
  }

  /**
   * This process's own session name. Claimed lazily: the constructor runs
   * before any browser is connected, and a name claimed then is claimed against
   * an empty set.
   */
  get sessionName() {
    return (this._sessionName ??= this._claimName());
  }

  /**
   * Mark a label as spoken for, both whole and by its distinguishing half.
   *
   * Labels arrive as `client · name` ("claude · harbor"). Reserving only the
   * whole string would let opencode claim `harbor` while Claude Code is still
   * on it — different labels, so different tab groups, but a human reading the
   * tab strip now sees two "harbor"s, which defeats the point of readable
   * names.
   */
  _reserve(label) {
    if (typeof label !== 'string' || !label) return;
    this.takenNames.add(label);
    const cut = label.lastIndexOf(' · ');
    if (cut !== -1) this.takenNames.add(label.slice(cut + 3));
  }

  /**
   * Ask the browser which workstream labels already exist and reserve them all.
   *
   * Failure is not fatal — an extension too old to know `__session_list` leaves
   * us exactly where we were before, uniquely naming everything this process
   * can see. Degraded, not broken.
   */
  async _seedTakenNames() {
    try {
      const res = await this._rawCall('__session_list', {}, { timeout: 5000 });
      const names = res?.names;
      if (Array.isArray(names)) {
        for (const label of names) this._reserve(label);
        if (names.length) this.log(`reserved ${names.length} session name(s) already in the browser`);
      }
    } catch {
      /* older extension, or it went away mid-handshake */
    }
    this._seeded = true;
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

      conn.on('close', () => {
        this.peers.delete(conn);
        // The name is deliberately *not* released. A finished session can leave
        // its tab group behind — cleanup only closes tabs it opened, not ones
        // it adopted — and handing the same name to the next session would drop
        // it straight into those leftover tabs. Names are cheap; collisions are
        // not.
        const name = conn.sessionLabel || conn.sessionName;
        if (name) this._endSession(name);
      });
      conn.on('message', (raw) => this._onPeerMessage(conn, raw));
      conn.sendJSON({
        type: 'hello',
        role: 'hub',
        extensionConnected: this.connected,
        // Withheld until the browser has said which names are in use. A peer
        // that connects before then is told its name in the `extension_status`
        // that follows the seed, which is also the message it is waiting on
        // before it can make a call at all.
        sessionName: this._seeded ? this._nameFor(conn) : undefined,
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
        // Names already handed out stay taken; what has to be re-established is
        // the browser's view, since a different browser may connect next.
        this._seeded = false;
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
      // Nobody is told the browser is ready until the seed is in, so no name
      // can be claimed against a stale picture of what is in use. The seed is
      // one loopback round trip and always settles, so this cannot wedge.
      this._seedTakenNames().then(() => {
        this._announceReady(msg);
        for (const resolve of this._waiters.splice(0)) resolve();
      });
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
      // A peer whose hub owner died reconnects to a brand new one, which has
      // never heard of it. Reserving on register is what stops that new hub
      // handing this peer's name to the next session that asks.
      this._reserve(msg.label);
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

  /** This peer's session name, claimed on first use. */
  _nameFor(peer) {
    return (peer.sessionName ??= this._claimName());
  }

  /**
   * Tell every peer the browser is ready, and — individually — what it is
   * called. Not a broadcast: the name differs per peer, and that difference is
   * the whole point.
   */
  _announceReady(info) {
    for (const peer of this.peers) {
      if (peer.closed) continue;
      peer.sendJSON({
        type: 'extension_status',
        connected: true,
        info,
        sessionName: this._nameFor(peer),
      });
    }
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

  /**
   * Ready to take calls. Includes the seed, so the first caller through here
   * cannot claim a name before the browser has said which ones are in use.
   */
  get connected() {
    return !!this.extension && !this.extension.closed && this._seeded;
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
    return this._rawCall(tool, args, { timeout });
  }

  /**
   * Send without waiting to be `connected`. Only the seed uses this — it runs
   * *during* the handshake that makes us connected, so going through `call()`
   * would deadlock on a wait it is itself responsible for ending.
   */
  _rawCall(tool, args = {}, { timeout } = {}) {
    const id = nextId();
    const promise = this.pending.create(id, { timeout });
    this.extension.sendJSON({ type: 'call', id, tool, args });
    return promise;
  }

  /** Record the label this session's tab group actually carries. */
  setSessionLabel(label) {
    this.sessionLabel = label;
    this._reserve(label);
  }

  async stop() {
    this.pending.rejectAll('hub shutting down');
    // A peer's cleanup is triggered by its socket closing; the hub owner has no
    // socket to close, so it has to say so on the way out. The short wait is
    // for the frame to reach the extension before the server is torn down.
    // `_sessionName`, not the getter: a hub owner that never drove a tab has no
    // name, and shutdown is not the moment to claim one.
    this._endSession(this.sessionLabel || this._sessionName);
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
        //
        // Once a label is committed it is final. Reconnecting to a *new* hub
        // owner gets a fresh assignment, but this session's tab group already
        // carries the old name — accepting the new one would strand those tabs
        // under a label nothing cleans up.
        if (msg.sessionName && !this.sessionLabel) this.sessionName = msg.sessionName;
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

    // Re-announce on every connect, not just the first. The hub owner is an
    // ordinary MCP server and can be killed; whoever binds the port next has
    // never heard of this session, and would hand its name — and so its tab
    // group — to the next client that joins.
    if (this.sessionLabel) this.conn.sendJSON({ type: 'register', label: this.sessionLabel });
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
