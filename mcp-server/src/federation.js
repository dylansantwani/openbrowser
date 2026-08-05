/**
 * Hub-to-hub federation.
 *
 *   laptop hub ──ws://cloud-a:8848/hub──> hub ──> Chrome
 *              ──ws://cloud-b:8848/hub──> hub ──> Chrome
 *
 * One MCP config, one local hub, N remote machines. The alternative — a tunnel
 * plus an mcp-server entry per target — needs a new local port and a new config
 * block for every machine you add, and a process babysitting each tunnel.
 *
 * The whole design rests on one idea: **a remote browser is just a browser**.
 * `RemoteBrowser` presents the same surface an extension connection does
 * (`instance`, `info`, `closed`, `sendJSON`), so it drops straight into
 * `liveBrowsers()` and every existing routing decision — `_routeFor`, the
 * chooser, session binding, the `_browser` identity stamp — works on it
 * unmodified. Nothing downstream knows federation exists.
 *
 * Two rules keep it comprehensible:
 *
 * 1. **Federation is one level deep.** A hub shares only its *local* browsers,
 *    never ones it reached through another hub. That makes cycles structurally
 *    impossible rather than something to detect: A→B→A cannot form because B has
 *    nothing of A's to offer back. It also keeps identity two-part
 *    (`remote/browser`) instead of an unbounded path.
 *
 * 2. **Names are namespaced at the boundary.** A remote browser is addressed as
 *    `remote/browser`. Two machines both running an unnamed Chrome would
 *    otherwise present the same label in one chooser, which is exactly the
 *    ambiguity the chooser exists to remove.
 */

import { connectWebSocket } from './ws.js';

/** How long a federated call may sit before we give up. */
const REMOTE_CALL_TIMEOUT_MS = 120_000;

/** Backoff between reconnection attempts to a remote hub. */
const RECONNECT_MS = 5_000;

/**
 * A browser living on another hub, wearing the same shape as a local extension
 * connection so the router cannot tell the difference.
 */
export class RemoteBrowser {
  constructor(link, desc) {
    this.link = link;
    /** The id this browser has on its *own* hub — what we send back over the wire. */
    this.remoteInstance = desc.instance;
    /**
     * The id it has *here*. Namespaced because instance ids are only unique
     * within one hub, exactly as tab ids are only unique within one browser.
     * Colliding ids across machines would route a call to the wrong box and
     * succeed there, which is the failure mode this project keeps re-learning.
     */
    this.instance = `${link.name}/${desc.instance}`;
    this.info = {
      ...(desc.info || {}),
      // `browserLabel` prefers info.name, so setting it here is all that is
      // needed for the namespaced name to appear in choosers and errors.
      name: `${link.name}/${desc.label || 'chrome'}`,
    };
    this.isRemote = true;
  }

  get closed() {
    return this.link.closed;
  }

  /**
   * Forward a call to the owning hub.
   *
   * `_rawCallTo` stamped `_browser` with our namespaced id; the far side has
   * never heard of that, so it is swapped back for the plain one. The id is
   * passed through untouched so the result can be settled by the local pending
   * map with no bookkeeping here.
   */
  sendJSON(msg) {
    this.link.send({
      type: 'call',
      id: msg.id,
      tool: msg.tool,
      browser: this.remoteInstance,
      args: { ...(msg.args || {}), _browser: this.remoteInstance },
    });
  }

  close() {
    /* Remote browsers are not ours to close; the link owns the socket. */
  }
}

/**
 * A connection to one remote hub.
 *
 * Reconnects on its own, because the far end is a machine that may reboot and
 * an agent should not have to re-issue `connect` to get its fleet back.
 */
export class RemoteLink {
  /**
   * @param {object} opts
   * @param {string} opts.name    local alias, and the namespace for its browsers
   * @param {string} opts.address host or host:port
   * @param {(id: string, ok: boolean, payload: any) => void} opts.onResult
   * @param {() => void} opts.onChange called when the remote browser set changes
   */
  constructor({ name, address, onResult, onChange, log = () => {} }) {
    this.name = name;
    this.address = address;
    this.url = toHubUrl(address);
    this.onResult = onResult;
    this.onChange = onChange;
    this.log = log;

    /** remoteInstance -> RemoteBrowser */
    this.browsers = new Map();
    this.conn = null;
    this.stopped = false;
    this.lastError = null;
    /** Calls sent to this hub and not yet answered, so a drop can fail them. */
    this.inFlight = new Set();
  }

  get closed() {
    return this.stopped || !this.conn || this.conn.closed;
  }

  /** Connected browsers on the far side. Empty while disconnected. */
  liveBrowsers() {
    return this.closed ? [] : [...this.browsers.values()];
  }

  async start() {
    await this._connect();
    return this;
  }

  async _connect() {
    if (this.stopped) return;
    this.conn = await connectWebSocket(this.url);
    this.lastError = null;

    this.conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // The far hub announces its browsers on connect and whenever they change,
      // so the local chooser reflects a remote Chrome opening or closing without
      // anyone re-issuing `connect`.
      if (msg.type === 'hello' || msg.type === 'browsers') {
        this._setBrowsers(msg.browsers || []);
        this.onChange?.();
        return;
      }

      if (msg.type === 'result') {
        this.inFlight.delete(msg.id);
        this.onResult(msg.id, msg.ok, msg.ok ? msg.result : msg.error);
      }
    });

    this.conn.on('close', () => {
      const had = this.browsers.size;
      this.browsers.clear();

      // Fail this link's calls only. Another remote going away must not disturb
      // work in flight elsewhere — the same rule `_onExtensionClose` follows for
      // one browser among several.
      for (const id of this.inFlight) {
        this.onResult(id, false, {
          message:
            `the remote hub "${this.name}" (${this.address}) disconnected mid-call. It reconnects automatically; ` +
            'retry shortly, or use browser_window action:"remotes" to check.',
        });
      }
      this.inFlight.clear();

      if (had) this.onChange?.();
      if (this.stopped) return;
      this.log(`remote hub "${this.name}" disconnected; retrying`);
      setTimeout(() => {
        this._connect().catch((err) => {
          this.lastError = err.message;
        });
      }, RECONNECT_MS).unref?.();
    });
  }

  _setBrowsers(list) {
    this.browsers.clear();
    for (const desc of list) {
      if (!desc?.instance) continue;
      this.browsers.set(desc.instance, new RemoteBrowser(this, desc));
    }
  }

  send(msg) {
    if (this.closed) throw new Error(`the remote hub "${this.name}" is not connected`);
    this.inFlight.add(msg.id);
    this.conn.sendJSON(msg);
  }

  stop() {
    this.stopped = true;
    this.browsers.clear();
    this.conn?.close();
  }
}

/**
 * Accept `host`, `host:port`, or a full ws:// URL.
 *
 * Bare hosts are the common case — an agent will write `10.0.0.5`, not
 * `ws://10.0.0.5:8848/hub` — and getting a URL parse error back for that is a
 * wasted turn.
 */
export function toHubUrl(address, defaultPort = 8848) {
  const raw = String(address || '').trim();
  if (!raw) throw new Error('a remote hub address is required, e.g. "10.0.0.5" or "10.0.0.5:8848"');

  if (/^wss?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (!u.port) u.port = String(defaultPort);
    u.pathname = '/hub';
    return u.toString();
  }

  // A bare IPv6 address is full of colons, so it only splits on the last one
  // when it is bracketed — "[::1]:8848". Unbracketed "::1" is all host.
  let host = raw;
  let port = defaultPort;
  if (raw.startsWith('[')) {
    const close = raw.lastIndexOf(']');
    host = raw.slice(0, close + 1);
    if (raw[close + 1] === ':') port = Number(raw.slice(close + 2)) || defaultPort;
  } else if (raw.includes(':') && raw.indexOf(':') === raw.lastIndexOf(':')) {
    const i = raw.lastIndexOf(':');
    host = raw.slice(0, i);
    port = Number(raw.slice(i + 1)) || defaultPort;
  } else if (raw.includes(':')) {
    host = `[${raw}]`; // bare IPv6
  }

  return `ws://${host}:${port}/hub`;
}

/** A short, stable alias for a remote, derived from its address. */
export function aliasFor(address, taken = new Set()) {
  const base =
    String(address || '')
      .replace(/^wss?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/[^a-zA-Z0-9.-]/g, '') || 'remote';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export { REMOTE_CALL_TIMEOUT_MS };
