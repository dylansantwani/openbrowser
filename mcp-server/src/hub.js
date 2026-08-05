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
import { RemoteLink, aliasFor } from './federation.js';

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

    /**
     * Every connected browser. All of them are live.
     *
     * This began as a single socket, which made two browsers fight for it; then
     * as a primary plus standbys, which stopped the fight by making the second
     * browser useless. Both were the same mistake — treating "the browser" as a
     * singleton when a work profile and a personal one, or Chrome beside a
     * Chromium build, is an ordinary setup. A session is bound to one browser;
     * the hub is bound to none.
     */
    this.extensions = new Set();

    /**
     * sessionLabel -> browser instance id.
     *
     * The hub is the only process that sees every session *and* every browser,
     * so it is the only place this can live — the same argument that puts
     * session-name allocation here. Re-seeded from the browsers on connect,
     * because a hub owner is an ordinary mcp-server and can be killed.
     */
    this.sessionBrowsers = new Map();

    /** call id -> the connection it was sent to, so results route back. */
    this._callConn = new Map();

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

    /** alias -> RemoteLink. Remote hubs whose browsers we can drive. */
    this.remotes = new Map();

    /**
     * Hubs that have connected to *us* over `/hub`, so we can push browser-list
     * changes to them. Receiving is always on — see `_onConnection` — but it is
     * only reachable if the hub was told to bind a non-loopback address, which
     * is the deliberate gate.
     */
    this.federates = new Set();

    /** Calls relayed on behalf of a federated hub: localId -> {conn, remoteId}. */
    this._federatedCalls = new Map();
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
    // Every browser, not just the newest: a session's tab group lives in
    // whichever browser it was working in, so asking only one leaves the other's
    // names free to be handed out again — dropping a fresh session straight into
    // a live session's tabs, which is the exact failure the seed exists to stop.
    await Promise.all(
      this.liveBrowsers().map(async (conn) => {
        try {
          const res = await this._rawCallTo(conn, '__session_list', {}, { timeout: 5000 });
          const names = res?.names;
          if (Array.isArray(names)) {
            for (const label of names) this._reserve(label);
            // Re-learn which browser each session belongs to. Without this a
            // hub that took over the port has no bindings, and every session
            // would be re-asked the chooser mid-task.
            for (const label of names) {
              if (!this.sessionBrowsers.has(label)) this.sessionBrowsers.set(label, conn.instance);
            }
            if (names.length) {
              this.log(`reserved ${names.length} session name(s) in ${describeBrowser(conn.info)}`);
            }
          }
        } catch {
          /* older extension, or it went away mid-handshake */
        }
      })
    );
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
        extensionConnected: this.liveBrowsers().length > 0,
        browsers: this.liveBrowsers().map((c) => ({
          name: browserLabel(c),
          browser: c.info?.browser ?? null,
          sessions: [...this.sessionBrowsers]
            .filter(([, inst]) => inst === c.instance)
            .map(([label]) => label),
        })),
        peers: this.peers.size,
      }),
    });

    this.server.on('connection', (conn) => this._onConnection(conn));
    await this.server.listen();
    this.log(`hub listening on ws://${this.host}:${this.port}`);
    return this;
  }

  _onConnection(conn) {
    // `/ext` is the extension; `/mcp` is another mcp-server process joining;
    // `/hub` is another *hub* federating to us.
    //
    // Receiving federation is deliberately always on — there is no toggle,
    // because a toggle in a second process is a security control living
    // somewhere other than the thing it protects. The real gate is the bind
    // address: this hub listens on 127.0.0.1 unless started with --host, so
    // nothing off-machine can reach this endpoint by default.
    if (conn.path === '/hub') {
      this._onFederateConnection(conn);
      return;
    }

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

    // Which browser this is only becomes knowable at its `hello`, so admission
    // is deferred until then — see `_admit`. Nothing is sent back before that
    // point, because the one thing worth saying is the answer.
    this.extensions.add(conn);
    conn.on('message', (raw) => this._onExtensionMessage(conn, raw));
    conn.on('close', () => this._onExtensionClose(conn));
  }

  /** Another hub has federated to us. Serve it our local browsers. */
  _onFederateConnection(conn) {
    this.federates.add(conn);
    this.log(`a remote hub connected (${this.federates.size} federated)`);

    conn.on('message', (raw) => this._onFederateMessage(conn, raw));
    conn.on('close', () => {
      this.federates.delete(conn);
      // Its in-flight calls can never be answered now; drop the mappings so the
      // maps do not grow for the lifetime of the process.
      for (const [localId, entry] of this._federatedCalls) {
        if (entry.conn === conn) this._federatedCalls.delete(localId);
      }
      this.log(`a remote hub disconnected (${this.federates.size} federated)`);
    });

    conn.sendJSON({ type: 'hello', role: 'hub', browsers: this._sharedBrowsers() });
  }

  /** Our local browsers, described for a federated hub. */
  _sharedBrowsers() {
    return this.localBrowsers().map((c) => ({
      instance: c.instance,
      label: browserLabel(c),
      info: c.info ? { browser: c.info.browser, version: c.info.version, name: c.info.name } : null,
    }));
  }

  /** Tell every federated hub our browser set changed, so their choosers stay true. */
  _announceFederates() {
    if (!this.federates.size) return;
    const browsers = this._sharedBrowsers();
    for (const conn of this.federates) {
      if (!conn.closed) conn.sendJSON({ type: 'browsers', browsers });
    }
  }

  _onFederateMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== 'call') return;

    const target = this.localBrowsers().find((c) => c.instance === msg.browser);
    if (!target) {
      conn.sendJSON({
        type: 'result',
        id: msg.id,
        ok: false,
        error: {
          message:
            `no browser with id "${msg.browser}" is connected to this hub. Connected: ` +
            (this._sharedBrowsers().map((b) => `"${b.label}"`).join(', ') || 'none') +
            '. The remote browser list may be stale — it refreshes on reconnect.',
        },
      });
      return;
    }

    // A fresh local id, because the calling hub's counter is a different
    // process's and could collide with our own. The far side's id is carried in
    // the map and restored on the way back.
    const localId = nextId();
    this._federatedCalls.set(localId, { conn, remoteId: msg.id });
    this._callConn.set(localId, target);
    target.sendJSON({
      type: 'call',
      id: localId,
      tool: msg.tool,
      // `_browser` is re-stamped with *our* instance id. The extension refuses
      // any call whose `_browser` is not its own, and the calling hub sent the
      // id it knows, which is the same one — but restamping here keeps the
      // guarantee local rather than trusting the peer to have got it right.
      args: { ...(msg.args || {}), _browser: target.instance },
    });
  }

  /**
   * A browser has introduced itself: register it, or replace its own earlier
   * socket.
   *
   * The rule used to be "the newest connection wins", which is right for the
   * case it was written for — an extension reload or an MV3 worker respawn
   * reconnecting — and ruinous for the case it did not anticipate. Two browsers
   * both connect, each evicts the other on arrival, and both reconnect a second
   * later: a permanent flap. Every eviction ran `rejectAll`, so agents mid-call
   * got "browser extension disconnected mid-call" at random.
   *
   * The missing fact was *identity*. A browser carries a stable instance id
   * (see `bridge.js`), so a reconnection from the same browser is recognisable
   * as one and still supersedes, while a different browser is recognisable as
   * different and simply joins. Nobody is evicted for existing.
   */
  _admit(conn) {
    // The same browser's earlier socket, if any. An extension reload leaves the
    // old one briefly open, and two live sockets for one browser would make
    // routing ambiguous — a call could go to the dead half.
    for (const other of this.extensions) {
      if (other === conn || other.closed) continue;
      if (other.instance != null && other.instance === conn.instance) {
        this.log(`${describeBrowser(conn.info)} reconnected; dropping its previous connection`);
        other.superseded = true;
        other.close(1000, 'superseded');
      }
    }

    conn.sendJSON({ type: 'hello', role: 'hub', browser: conn.instance });
    this.log(`browser connected: ${describeBrowser(conn.info)} (${this.liveBrowsers().length} now connected)`);

    // Nobody is told a browser is ready until the seed is in, so no name can be
    // claimed against a stale picture of what is in use. The seed asks every
    // browser, since a session's tab group may live in any of them.
    this._seedTakenNames().then(() => {
      this._announceReady(conn.info);
      for (const resolve of this._waiters.splice(0)) resolve();
    });
    this._announceFederates();
  }

  /**
   * Browsers attached directly to this hub.
   *
   * Only these are ever offered to a federated hub. Re-sharing browsers we
   * ourselves reached through someone else is what would let A→B→A form, and a
   * loop here is not a hang but a call that ping-pongs until it times out. One
   * level deep makes the cycle impossible instead of detectable.
   */
  localBrowsers() {
    return [...this.extensions].filter((c) => !c.closed && c.info);
  }

  /** Every browser this hub can drive: its own, plus every remote hub's. */
  liveBrowsers() {
    const out = this.localBrowsers();
    for (const link of this.remotes.values()) out.push(...link.liveBrowsers());
    return out;
  }

  /** A browser by its configured name, case-insensitively. */
  _browserByName(name) {
    const wanted = String(name).trim().toLowerCase();
    return this.liveBrowsers().find((c) => browserLabel(c).toLowerCase() === wanted) || null;
  }

  _onExtensionClose(conn) {
    this.extensions.delete(conn);
    // A reload's old socket: its replacement is already registered, so nothing
    // here is news. Announcing a disconnect would flap the peers' status.
    if (conn.superseded) return;

    // Only calls that were in flight *to this browser*. Rejecting everything
    // was survivable when there was one browser and is plainly wrong now — one
    // browser closing must not fail another browser's work.
    for (const [id, target] of this._callConn) {
      if (target !== conn) continue;
      this._callConn.delete(id);
      this.pending.settle(id, false, {
        message:
          `the browser "${browserLabel(conn)}" disconnected mid-call. Its session binding is kept, so retry once it ` +
          'reconnects, or bind another with browser_window action:"use" browser:<name> windowId:<id>.',
      });
    }

    // Bindings are deliberately kept. An extension reload is routine, the
    // session's tabs are still sitting in that browser, and re-binding it to
    // whatever else happens to be connected is precisely the silent wrong-target
    // failure this whole design exists to prevent.
    this.log(`browser disconnected: ${describeBrowser(conn.info)} (${this.liveBrowsers().length} left)`);
    this._announceFederates();
    if (!this.liveBrowsers().length) {
      this._seeded = false;
      this._broadcastPeers({ type: 'extension_status', connected: false });
    }
  }

  _onExtensionMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      conn.info = msg;
      conn.instance = msg.instance ?? null;
      this._admit(conn);
      return;
    }

    if (msg.type === 'result') {
      // Results are matched by call id, which is unique across every browser —
      // so a browser cannot settle a call that was never sent to it.
      if (this._callConn.get(msg.id) !== conn) return;
      this._callConn.delete(msg.id);

      // Results for a federated hub's call go back with *its* id restored.
      const fed = this._federatedCalls.get(msg.id);
      if (fed) {
        this._federatedCalls.delete(msg.id);
        if (!fed.conn.closed) fed.conn.sendJSON({ ...msg, id: fed.remoteId });
        return;
      }

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

    // Hub-only questions are answered here too, or a peer's session could never
    // see the browser list — or attach a remote hub.
    this._localAnswer(msg.tool, msg.args || {})
      .then((local) => {
        if (local) {
          peer.sendJSON({ type: 'result', id: msg.id, ok: true, result: local });
          return;
        }

        // A peer's call is routed exactly like a local one — the peer's session
        // is in `args._session`, so the same binding applies. Routing failures
        // come back as ordinary errors, which is how the chooser reaches an
        // agent running in another mcp-server process.
        return this._routeFor(msg.args || {}).then((conn) => {
          this._callOwners ??= new Map();
          this._callOwners.set(msg.id, peer);
          this._callConn.set(msg.id, conn);
          conn.sendJSON({ ...msg, args: { ...(msg.args || {}), _browser: conn.instance } });
        });
      })
      .catch((err) => {
        if (!peer.closed) {
          peer.sendJSON({ type: 'result', id: msg.id, ok: false, error: { message: err.message } });
        }
      });
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
    if (!name) return;
    // Sent to the browser this session was bound to, if it is still there;
    // otherwise to all of them, since a session's tabs can only be tidied by
    // the browser holding them and a lost binding must not strand a tab group.
    const bound = this.sessionBrowsers.get(name);
    const targets = bound
      ? this.liveBrowsers().filter((c) => c.instance === bound)
      : this.liveBrowsers();
    this.sessionBrowsers.delete(name);
    for (const conn of targets) {
      conn.sendJSON({
        type: 'call',
        id: `session-end-${name}-${this.peers.size}`,
        tool: '__session_end',
        args: { _session: name, _browser: conn.instance },
      });
    }
  }

  /**
   * Ready to take calls. Includes the seed, so the first caller through here
   * cannot claim a name before the browsers have said which names are in use.
   */
  get connected() {
    return this.liveBrowsers().length > 0 && this._seeded;
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

  /**
   * The browser a session works in, asking if there is any doubt.
   *
   * Deliberately the same shape as `ensureWindow` one level out: bound sessions
   * go straight through, a single browser is never a question, and anything
   * ambiguous raises a chooser rather than picking. Guessing here is worse than
   * guessing a window — tab ids are only unique *within* a browser, so a call
   * sent to the wrong one does not fail, it succeeds on a different page.
   *
   * @throws {Error} the chooser, when a human has to decide
   */
  async _routeFor(args) {
    const label = args._session;
    const live = this.liveBrowsers();
    if (!live.length) throw new Error(NO_EXTENSION);

    // An explicit name always wins, and re-binds. This is how the human's answer
    // to the chooser gets back in.
    if (args.browser != null) {
      const named = this._browserByName(args.browser);
      if (!named) {
        throw new Error(
          `no connected browser is called "${args.browser}". Connected: ` +
            live.map((c) => `"${browserLabel(c)}"`).join(', ') +
            '. Names are set in the extension options of each browser.'
        );
      }
      if (label) this.sessionBrowsers.set(label, named.instance);
      return named;
    }

    const bound = label && this.sessionBrowsers.get(label);
    if (bound) {
      const conn = live.find((c) => c.instance === bound);
      if (conn) return conn;
      // Kept, not reassigned — see `_onExtensionClose`.
      throw new Error(
        `the browser "${label}" works in is not connected right now. Reopen it, or move this session with ` +
          'browser_window action:"use" browser:<name> windowId:<id>. Connected: ' +
          live.map((c) => `"${browserLabel(c)}"`).join(', ') +
          '.'
      );
    }

    if (live.length === 1) {
      if (label) this.sessionBrowsers.set(label, live[0].instance);
      return live[0];
    }

    throw await this._chooser(label, live);
  }

  /**
   * One question covering every window in every browser.
   *
   * Two questions — which browser, then which window — is the obvious shape and
   * the wrong one: nobody thinks "the work browser, then the second window",
   * they think "that window over there". Picking a window names its browser
   * implicitly, so one answer binds both.
   */
  async _chooser(label, live) {
    const perBrowser = await Promise.all(
      live.map(async (conn) => {
        try {
          const res = await this._rawCallTo(conn, '__window_list', {}, { timeout: 5000 });
          return { conn, windows: res?.windows || [] };
        } catch {
          // A browser that cannot answer still has to appear, or the human is
          // offered a choice that silently omits where they are looking.
          return { conn, windows: null };
        }
      })
    );

    const lines = [];
    let n = 0;
    for (const { conn, windows } of perBrowser) {
      const name = browserLabel(conn);
      if (windows == null) {
        lines.push(`  · ${name} — could not list its windows`);
        continue;
      }
      for (const w of windows) {
        lines.push(
          `  ${++n} · browser:"${name}" windowId:${w.windowId}  (${w.tabs} tab${w.tabs === 1 ? '' : 's'})` +
            (w.titles?.length ? `  ${w.titles.join(', ')}` : '')
        );
      }
    }

    return new Error(
      `${live.length} browsers are connected — ask the user which one "${label || 'this session'}" should work in. ` +
        'Nothing has been opened yet.\n' +
        lines.join('\n') +
        '\nThen call browser_window action:"use" browser:<name> windowId:<id> with their answer. ' +
        'That binds the browser and the window together.'
    );
  }

  /**
   * Attach to another hub. Its browsers join `liveBrowsers()` under `alias/…`.
   */
  async connectRemote(address, alias) {
    const name = String(alias || aliasFor(address, new Set(this.remotes.keys()))).trim();
    if (!name) throw new Error('a name for the remote hub is required');
    if (this.remotes.has(name)) {
      throw new Error(`already connected to a remote hub called "${name}" — disconnect it first.`);
    }

    const link = new RemoteLink({
      name,
      address,
      log: this.log,
      onResult: (id, ok, payload) => this._settleFromRemote(id, ok, payload),
      onChange: () => this._onRemoteChange(),
    });

    try {
      await link.start();
    } catch (err) {
      throw new Error(
        `could not reach a hub at ${address}: ${err.message}. The far end must be running with ` +
          '--host 0.0.0.0 (it binds loopback by default) and its port must be reachable.'
      );
    }

    this.remotes.set(name, link);
    this._onRemoteChange();
    return { name, link };
  }

  /** Detach a remote hub and drop any session bindings that pointed into it. */
  disconnectRemote(name) {
    const link = this.remotes.get(name);
    if (!link) {
      throw new Error(
        `no remote hub called "${name}". Connected: ` +
          ([...this.remotes.keys()].map((n) => `"${n}"`).join(', ') || 'none') +
          '.'
      );
    }
    // A binding into a hub that is gone would fail every later call with "not
    // connected right now" and no way to clear it.
    for (const [label, inst] of [...this.sessionBrowsers]) {
      if (String(inst).startsWith(`${name}/`)) this.sessionBrowsers.delete(label);
    }
    link.stop();
    this.remotes.delete(name);
    return link;
  }

  /**
   * Settle a call that was answered by a remote hub.
   *
   * Mirrors the local result path: a call made on behalf of a peer goes back to
   * that peer, anything else resolves this process's own promise.
   */
  _settleFromRemote(id, ok, payload) {
    this._callConn.delete(id);
    const owner = this._callOwners?.get(id);
    if (owner) {
      this._callOwners.delete(id);
      if (!owner.closed) {
        owner.sendJSON({ type: 'result', id, ok, ...(ok ? { result: payload } : { error: payload }) });
      }
      return;
    }
    this.pending.settle(id, ok, payload);
  }

  /**
   * A remote hub's browser set changed.
   *
   * The seed normally runs when a local extension says hello. With only remote
   * browsers attached that never happens, and `connected` — which requires
   * `_seeded` — would stay false forever, blocking every call behind
   * `waitForExtension`. So a remote arriving seeds too.
   */
  _onRemoteChange() {
    if (this._seeded || this._seeding || !this.liveBrowsers().length) return;
    this._seeding = true;
    this._seedTakenNames()
      .then(() => {
        this._announceReady(this.liveBrowsers()[0]?.info);
        for (const resolve of this._waiters.splice(0)) resolve();
      })
      .finally(() => {
        this._seeding = false;
      });
  }

  /**
   * Questions only the hub can answer, because no single browser can see the
   * others. Returns a result, or null to route the call normally.
   */
  async _localAnswer(tool, args) {
    if (tool !== 'browser_window') return null;

    if (args.action === 'connect') {
      const { name } = await this.connectRemote(args.hub, args.name);
      const link = this.remotes.get(name);
      const found = link.liveBrowsers();
      return {
        text:
          `Connected to the hub at ${args.hub} as "${name}". ` +
          (found.length
            ? `${found.length} browser(s) available: ${found.map((b) => `"${browserLabel(b)}"`).join(', ')}. ` +
              'Bind one with browser_window action:"use" browser:<name>.'
            : 'It has no browsers connected yet; they appear here as they arrive.'),
      };
    }

    if (args.action === 'disconnect') {
      this.disconnectRemote(args.name || args.hub);
      return { text: `Disconnected from remote hub "${args.name || args.hub}".` };
    }

    if (args.action === 'remotes') {
      if (!this.remotes.size) {
        return {
          text: 'No remote hubs connected. Attach one with browser_window action:"connect" hub:"<host>" — the far end must be running with --host 0.0.0.0.',
        };
      }
      const lines = [...this.remotes.values()].map((link) => {
        const bs = link.liveBrowsers();
        return (
          `  "${link.name}" — ${link.address} — ${link.closed ? 'disconnected (retrying)' : 'connected'}` +
          (bs.length ? `, ${bs.length} browser(s): ${bs.map((b) => `"${browserLabel(b)}"`).join(', ')}` : ', no browsers') +
          (link.lastError ? `  [${link.lastError}]` : '')
        );
      });
      return { text: `${this.remotes.size} remote hub(s):\n${lines.join('\n')}` };
    }

    if (args.action !== 'browsers') return null;

    const live = this.liveBrowsers();
    if (!live.length) return { text: NO_EXTENSION };

    const label = args._session;
    const bound = label && this.sessionBrowsers.get(label);
    const lines = live.map((conn) => {
      const sessions = [...this.sessionBrowsers]
        .filter(([, inst]) => inst === conn.instance)
        .map(([s]) => (s === label ? `${s} (you)` : s));
      const named = conn.info?.name?.trim() ? '' : '  (unnamed — set one in this browser\'s extension options)';
      return (
        `  "${browserLabel(conn)}" — ${conn.info?.browser || 'chrome'}` +
        (conn.instance === bound ? '  ← your browser' : '') +
        (sessions.length ? `  ← ${sessions.join(', ')}` : '') +
        named
      );
    });

    return {
      text:
        `${live.length} browser(s) connected:\n${lines.join('\n')}\n` +
        (bound
          ? `"${label}" works in "${browserLabel(live.find((c) => c.instance === bound)) || bound}".`
          : `"${label || 'this session'}" is not bound to a browser yet — ` +
            'browser_window action:"use" browser:<name> windowId:<id>.'),
    };
  }

  /** Invoke a tool in the session's browser. @returns {Promise<any>} */
  async call(tool, args = {}, { timeout } = {}) {
    // `connect` is the one call that must work with nothing attached — it is
    // how you attach something. Waiting for a browser first would deadlock a
    // hub whose only browsers are on the machine it has not connected to yet.
    const hubOnly =
      tool === 'browser_window' && ['connect', 'disconnect', 'remotes'].includes(args.action);
    if (!hubOnly && !this.connected) await this.waitForExtension();
    const local = await this._localAnswer(tool, args);
    if (local) return local;
    const conn = await this._routeFor(args);
    return this._rawCallTo(conn, tool, args, { timeout });
  }

  /**
   * Send to a named connection without waiting to be `connected`. The seed uses
   * it because it runs *during* the handshake that makes us connected, so going
   * through `call()` would deadlock on a wait it is itself responsible for
   * ending; routing uses it because it has already chosen the browser.
   */
  _rawCallTo(conn, tool, args = {}, { timeout } = {}) {
    const id = nextId();
    const promise = this.pending.create(id, { timeout });
    this._callConn.set(id, conn);
    // `_browser` is stamped here, after the caller's args, for the same reason
    // `_session` is stamped in index.js after the spread: it is an assertion of
    // identity and a model must not be able to forge it. The extension refuses
    // any call whose `_browser` is not its own instance, which turns a misroute
    // — otherwise a silent success on the wrong browser's tab of the same id —
    // into a loud error.
    conn.sendJSON({ type: 'call', id, tool, args: { ...args, _browser: conn.instance } });
    return promise;
  }

  /** Record the label this session's tab group actually carries. */
  setSessionLabel(label) {
    this.sessionLabel = label;
    this._reserve(label);
  }

  async stop() {
    for (const link of this.remotes.values()) link.stop();
    this.remotes.clear();
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
    this.opts = { port, host, log };
    this.log = log;
    this.pending = new PendingCalls();
    this.conn = null;
    this.extensionConnected = false;
    this._waiters = [];
    /** Set once this process has been elected owner — see `_tryTakeOver`. */
    this.owner = null;
  }

  async start() {
    await this._connect();
    return this;
  }

  /**
   * Become the hub if nobody is holding the port.
   *
   * The reconnect path used to say it could "take over or rejoin" and could
   * only ever rejoin: it called `connectWebSocket` and nothing else. So when
   * the owning mcp-server exited — an editor restarting, a client being killed
   * — every surviving secondary spun at one attempt per second against a port
   * that nobody was listening on, forever. Nothing crashed and nothing logged
   * an error; there were simply live mcp-server processes, no hub, and every
   * browser stuck retrying. Observed exactly that way: two `index.js` processes
   * running, nothing bound to 8848, one extension flapping and one reporting
   * disconnected.
   *
   * Election is the bind itself, which is atomic — whoever gets the port is the
   * owner and everyone else gets EADDRINUSE and joins them, which is the same
   * rule `createTransport` uses at startup.
   */
  async _tryTakeOver() {
    if (this.owner) return true;
    const hub = new Hub(this.opts);
    try {
      await hub.start();
    } catch (err) {
      if (err.code === 'EADDRINUSE') return false; // someone else won; join them
      throw err;
    }

    // Keep the name this session already has. Its tab group carries that label,
    // and letting the new hub allocate a fresh one would strand those tabs
    // under a name nothing will ever clean up.
    if (this.sessionName) {
      hub._sessionName = this.sessionName;
      hub._reserve(this.sessionName);
    } else {
      this.sessionName = hub.sessionName;
    }
    if (this.sessionLabel) hub.setSessionLabel(this.sessionLabel);

    this.owner = hub;
    this.log('previous hub owner exited; took over the port');
    return true;
  }

  async _connect() {
    // Try to become the owner first. Skipping this is what left a dead port
    // with live servers around it.
    if (await this._tryTakeOver()) return;

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
      // The owner may have exited. `_connect` now tries to bind the port before
      // joining, so this genuinely does take over rather than only claiming to.
      setTimeout(() => this._connect().catch(() => {}), 1000).unref?.();
    });

    await helloSeen;

    // Re-announce on every connect, not just the first. The hub owner is an
    // ordinary MCP server and can be killed; whoever binds the port next has
    // never heard of this session, and would hand its name — and so its tab
    // group — to the next client that joins.
    if (this.sessionLabel) this.conn.sendJSON({ type: 'register', label: this.sessionLabel });
  }

  // Once elected, every question is the owning hub's to answer. Forwarding
  // rather than re-implementing keeps one behaviour for callers, which is the
  // property that let `index.js` stay ignorant of which role it got.

  get connected() {
    return this.owner ? this.owner.connected : this.extensionConnected;
  }

  waitForExtension(timeout = 20_000) {
    if (this.owner) return this.owner.waitForExtension(timeout);
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
    if (this.owner) return this.owner.call(tool, args, { timeout });
    if (!this.conn || this.conn.closed) {
      await this._connect();
      // `_connect` may have won the port on the way through.
      if (this.owner) return this.owner.call(tool, args, { timeout });
    }
    const id = nextId();
    const promise = this.pending.create(id, { timeout });
    this.conn.sendJSON({ type: 'call', id, tool, args });
    return promise;
  }

  setSessionLabel(label) {
    this.sessionLabel = label;
    if (this.owner) return void this.owner.setSessionLabel(label);
    if (this.conn && !this.conn.closed) this.conn.sendJSON({ type: 'register', label });
  }

  async stop() {
    this.pending.rejectAll('shutting down');
    this.conn?.close();
    // Releases the port, so the next survivor can win it.
    await this.owner?.stop();
  }
}

/**
 * The name a human uses for a browser, and an agent passes as `browser:`.
 *
 * Set in each browser's extension options, because only a human knows that one
 * of them is "work". Unnamed browsers still need something stable and
 * distinguishable — "chrome" twice would be unusable in a chooser — so the
 * instance id's tail stands in until someone names it.
 */
function browserLabel(conn) {
  const configured = conn?.info?.name;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const brand = (conn?.info?.browser || 'chrome').split(' ')[0].toLowerCase();
  const tail = String(conn?.instance || '').replace(/-/g, '').slice(-4);
  return tail ? `${brand}·${tail}` : brand;
}

/** A browser, as a human would name it in a sentence about which one is which. */
function describeBrowser(info) {
  if (!info) return 'an unidentified browser';
  const name = info.name?.trim() || info.browser || 'chrome';
  return info.version ? `${name} v${info.version}` : name;
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
