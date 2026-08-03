/**
 * Model Context Protocol server over stdio.
 *
 * MCP is JSON-RPC 2.0 with newline-delimited messages on stdin/stdout. That is
 * small enough to implement directly, which keeps this package dependency-free
 * and keeps the wire behaviour inspectable when something misbehaves.
 *
 * Hard rule: stdout carries protocol frames only. Anything we want to say to a
 * human goes to stderr, or it corrupts the stream and the client drops us.
 */

import { createInterface } from 'node:readline';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';

const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

export class McpServer {
  /**
   * @param {object} opts
   * @param {{name: string, version: string}} opts.serverInfo
   * @param {string} [opts.instructions]
   * @param {Array} opts.tools JSON-Schema tool descriptors
   * @param {(name: string, args: object) => Promise<any>} opts.onCall
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ serverInfo, instructions, tools, onCall, log = () => {} }) {
    this.serverInfo = serverInfo;
    this.instructions = instructions;
    this.tools = tools;
    this.onCall = onCall;
    this.log = log;
    this.protocolVersion = FALLBACK_PROTOCOL;
  }

  start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const text = line.trim();
      if (text) this._onLine(text);
    });
    rl.on('close', () => process.exit(0));

    // A broken stdout means the client is gone. Exit quietly rather than
    // spewing EPIPE traces into someone's editor log.
    process.stdout.on('error', (err) => {
      if (err.code === 'EPIPE') process.exit(0);
    });
    return this;
  }

  _write(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  _reply(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  _fail(id, code, message, data) {
    this._write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  }

  async _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._fail(null, ErrorCode.ParseError, 'invalid JSON');
      return;
    }

    // Notifications have no id and must never be answered.
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      const result = await this._handle(msg);
      if (!isNotification) this._reply(msg.id, result ?? {});
    } catch (err) {
      this.log(`error handling ${msg.method}: ${err.stack || err.message}`);
      if (!isNotification) {
        this._fail(msg.id, err.code ?? ErrorCode.InternalError, err.message || 'internal error');
      }
    }
  }

  async _handle(msg) {
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        this.protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
        // Remember who connected. The browser labels this session's tab group
        // with it, so a human looking at a window full of tabs can tell which
        // agent opened what.
        this.clientInfo = msg.params?.clientInfo || null;
        return {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: this.tools };

      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (!name) {
          throw Object.assign(new Error('missing tool name'), { code: ErrorCode.InvalidParams });
        }
        return this._callTool(name, args);
      }

      // Declared-but-empty so clients that probe these do not log errors.
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };

      default:
        throw Object.assign(new Error(`unknown method: ${msg.method}`), {
          code: ErrorCode.MethodNotFound,
        });
    }
  }

  async _callTool(name, args) {
    try {
      const result = await this.onCall(name, args);
      return { content: toContent(result), isError: false };
    } catch (err) {
      // Tool failures are reported in-band with isError, not as JSON-RPC errors.
      // That lets the model read the message and recover instead of the client
      // treating it as a transport fault.
      return {
        content: [{ type: 'text', text: err.message || String(err) }],
        isError: true,
      };
    }
  }
}

/**
 * Normalise a tool's return value into MCP content blocks.
 *
 * Tools return either a plain string (the common case — our results are already
 * formatted for reading), or `{text, images:[{data, mimeType}]}` when there is
 * an attachment.
 */
function toContent(result) {
  if (result == null) return [{ type: 'text', text: 'ok' }];
  if (typeof result === 'string') return [{ type: 'text', text: result }];

  const blocks = [];
  if (result.text) blocks.push({ type: 'text', text: result.text });

  for (const img of result.images ?? []) {
    blocks.push({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType || 'image/jpeg',
    });
  }

  if (!blocks.length) blocks.push({ type: 'text', text: JSON.stringify(result) });
  return blocks;
}
