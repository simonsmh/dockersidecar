#!/usr/bin/env node
'use strict';

/**
 * ACP Sidecar — Node.js HTTP Server
 *
 * 封装 runner（Claude Code CLI / Kiro CLI）的 stdin/stdout JSON-RPC 2.0 通信为 HTTP 接口。
 * 零外部依赖，仅使用 Node.js 内置模块。
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

// ─── 环境变量配置 ───────────────────────────────────────────

const RUNNER_CMD = process.env.ACP_RUNNER_CMD || 'claude mcp serve';
const SIDECAR_PORT = parseInt(process.env.ACP_SIDECAR_PORT || '3000', 10);
const WORKSPACE = process.env.ACP_WORKSPACE || '/home/node';
const RUNNER_STARTUP_TIMEOUT_MS = parseInt(process.env.ACP_RUNNER_STARTUP_TIMEOUT_MS || '30000', 10);
const MAX_REQUEST_BODY_BYTES = parseInt(process.env.ACP_MAX_REQUEST_BODY_BYTES || String(50 * 1024 * 1024), 10);
const AUTO_RESTART = (process.env.ACP_AUTO_RESTART || 'true') === 'true';
const REQUEST_TIMEOUT_SEC = parseInt(process.env.ACP_REQUEST_TIMEOUT_SEC || '600', 10);
const PROMPT_SERIAL = (process.env.ACP_PROMPT_SERIAL || 'true') === 'true';

// ─── 状态机 ────────────────────────────────────────────────

const State = {
  INIT: 'init',
  STARTING: 'starting',
  READY: 'ready',
  ERROR: 'error',
};

let currentState = State.INIT;

// ─── 日志工具 ───────────────────────────────────────────────

function log(...args) {
  console.log(`[sidecar ${new Date().toISOString()}]`, ...args);
}

function logError(...args) {
  console.error(`[sidecar ${new Date().toISOString()}]`, ...args);
}

// ─── 路径安全校验 ───────────────────────────────────────────

/**
 * 校验路径是否在工作区内，防止路径穿越攻击。
 * @param {string} reqPath 请求的相对或绝对路径
 * @returns {{safe: boolean, resolved: string, error?: string}}
 */
function validatePath(reqPath) {
  if (!reqPath) {
    return { safe: false, resolved: '', error: 'Path is required' };
  }

  // 解析为绝对路径
  const resolved = path.resolve(WORKSPACE, reqPath);

  // 确保在工作区内
  const normalizedWorkspace = path.resolve(WORKSPACE);
  if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
    return { safe: false, resolved, error: 'Path traversal detected' };
  }

  return { safe: true, resolved };
}

// ─── 文件操作工具 ───────────────────────────────────────────

/**
 * 递归搜索文件
 * @param {string} dir 目录
 * @param {string} pattern 搜索模式（简单通配符）
 * @param {number} maxResults 最大结果数
 * @param {string[]} results 结果数组
 */
function searchFiles(dir, pattern, maxResults, results = []) {
  if (results.length >= maxResults) return results;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // 跳过隐藏目录和 node_modules
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        searchFiles(fullPath, pattern, maxResults, results);
      }
    } else if (regex.test(entry.name)) {
      results.push(path.relative(WORKSPACE, fullPath));
    }
  }

  return results;
}

// ─── JSON-RPC Multiplexer ───────────────────────────────────

class JsonRpcMultiplexer {
  constructor() {
    /** @type {Map<string|number, {resolve: Function, reject: Function, timer: NodeJS.Timeout, sseRes?: http.ServerResponse}>} */
    this.pending = new Map();

    /** @type {Set<http.ServerResponse>} */
    this.subscribers = new Set();

    /** @type {import('child_process').ChildProcess | null} */
    this.runner = null;

    /** @type {boolean} */
    this.shuttingDown = false;

    /** @type {number} */
    this.startTime = Date.now();

    /** @type {NodeJS.Timeout | null} */
    this.startupTimer = null;

    // Prompt 串行队列
    /** @type {Promise<void>} */
    this._promptQueue = Promise.resolve();
  }

  // ── Runner 进程管理 ──────────────────────────────────────

  startRunner() {
    if (this.runner) {
      log('Runner already running, stopping first...');
      this.stopRunner();
    }

    currentState = State.STARTING;
    const parts = RUNNER_CMD.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    log(`Starting runner: ${cmd} ${args.join(' ')}`);

    this.runner = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: WORKSPACE,
      env: { ...process.env },
    });

    // 启动超时检测
    this.startupTimer = setTimeout(() => {
      if (currentState === State.STARTING) {
        logError(`Runner startup timeout after ${RUNNER_STARTUP_TIMEOUT_MS}ms`);
        currentState = State.ERROR;
        this.stopRunner();
      }
    }, RUNNER_STARTUP_TIMEOUT_MS);

    this.runner.on('error', (err) => {
      logError(`Runner spawn error: ${err.message}`);
      currentState = State.ERROR;
      this._handleRunnerExit(-1);
    });

    // stdout: 逐行读取 JSON-RPC 消息
    const rl = createInterface({ input: this.runner.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      this._handleStdoutLine(line);
    });

    // stderr: 转发到 console.error
    const stderrRl = createInterface({ input: this.runner.stderr, crlfDelay: Infinity });
    stderrRl.on('line', (line) => {
      console.error(`[runner] ${line}`);
    });

    this.runner.on('exit', (code, signal) => {
      log(`Runner exited: code=${code}, signal=${signal}`);
      this._handleRunnerExit(code);
    });

    // 标记为 ready（收到第一条消息时或短暂延迟后）
    setTimeout(() => {
      if (currentState === State.STARTING && this.runner) {
        currentState = State.READY;
        if (this.startupTimer) {
          clearTimeout(this.startupTimer);
          this.startupTimer = null;
        }
        log('Runner marked as ready');
      }
    }, 1000);
  }

  stopRunner() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    if (this.runner) {
      log('Stopping runner...');
      this.runner.kill('SIGTERM');
      // 强制 kill 超时
      setTimeout(() => {
        if (this.runner) {
          log('Force killing runner...');
          this.runner.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  restartRunner() {
    log('Restarting runner...');
    this.stopRunner();
    setTimeout(() => this.startRunner(), 1000);
  }

  _handleRunnerExit(code) {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    // 拒绝所有 pending 请求
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Runner exited with code ${code}`));
    }
    this.pending.clear();

    this.runner = null;
    currentState = State.INIT;

    if (this.shuttingDown) {
      log('Runner stopped, sidecar exiting.');
      process.exit(0);
      return;
    }

    if (AUTO_RESTART) {
      log('Auto-restarting runner in 1s...');
      setTimeout(() => this.startRunner(), 1000);
    } else {
      log('Auto-restart disabled, waiting for manual start.');
    }
  }

  // ── stdout 消息分发 ──────────────────────────────────────

  _handleStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      // 非 JSON 行，忽略（可能是 runner 的普通输出）
      log(`Non-JSON stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    // 收到有效 JSON-RPC 消息，标记为 ready
    if (currentState === State.STARTING) {
      currentState = State.READY;
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      log('Runner is ready (received first JSON-RPC message)');
    }

    // 判断是 response 还是 notification
    const isResponse = msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined);
    const isNotification = msg.method && (msg.id === undefined || msg.id === null);

    if (isResponse) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);

        // 如果有关联的 SSE response，推送最终结果
        if (entry.sseRes) {
          const eventType = msg.error ? 'error' : 'response';
          this._writeSseEvent(entry.sseRes, eventType, msg);
          entry.sseRes.end();
        }

        entry.resolve(msg);
      } else {
        log(`No pending entry for response id=${msg.id}`);
      }
    } else if (isNotification) {
      this._broadcastNotification(msg);
    } else {
      log(`Unclassified message: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }

  // ── Notification 广播 ────────────────────────────────────

  _broadcastNotification(msg) {
    // 推送给 /rpc/stream 的长连接订阅者
    for (const res of this.subscribers) {
      this._writeSseEvent(res, 'notification', msg);
    }

    // 推送给所有关联了 SSE 的 pending 请求
    for (const [, entry] of this.pending) {
      if (entry.sseRes) {
        this._writeSseEvent(entry.sseRes, 'notification', msg);
      }
    }
  }

  // ── SSE 写入 ─────────────────────────────────────────────

  _writeSseEvent(res, event, data) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // 连接已断开
    }
  }

  // ── 发送 JSON-RPC 请求（一次性返回） ─────────────────────

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.runner || !this.runner.stdin.writable) {
        return reject(new Error('Runner not available'));
      }

      const id = msg.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_SEC}s`));
      }, REQUEST_TIMEOUT_SEC * 1000);

      this.pending.set(id, { resolve, reject, timer });

      this.runner.stdin.write(JSON.stringify(msg) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── 发送 JSON-RPC 请求（SSE 流式返回） ───────────────────

  sendStreaming(msg, sseRes) {
    return new Promise((resolve, reject) => {
      if (!this.runner || !this.runner.stdin.writable) {
        return reject(new Error('Runner not available'));
      }

      const id = msg.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Request timeout after ${REQUEST_TIMEOUT_SEC}s`);
        this._writeSseEvent(sseRes, 'error', {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message },
        });
        sseRes.end();
        reject(err);
      }, REQUEST_TIMEOUT_SEC * 1000);

      this.pending.set(id, { resolve, reject, timer, sseRes });

      // 客户端断开时清理
      sseRes.on('close', () => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          // resolve 以释放 prompt 串行队列，避免永久阻塞
          entry.resolve({ jsonrpc: '2.0', id, result: { stopReason: 'client_disconnected' } });
        }
      });

      this.runner.stdin.write(JSON.stringify(msg) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── Prompt 串行控制 ──────────────────────────────────────

  enqueuePrompt(fn) {
    if (!PROMPT_SERIAL) return fn();
    const prev = this._promptQueue;
    const next = prev.then(() => fn(), () => fn());
    this._promptQueue = next;
    return next;
  }

  // ── 订阅管理 ─────────────────────────────────────────────

  addSubscriber(res) {
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  // ── 优雅关闭 ─────────────────────────────────────────────

  async shutdown() {
    this.shuttingDown = true;

    // 关闭所有 SSE 连接
    for (const res of this.subscribers) {
      if (!res.writableEnded) res.end();
    }
    this.subscribers.clear();

    if (this.runner) {
      log('Sending SIGTERM to runner...');
      this.runner.kill('SIGTERM');

      // 等待最多 10s
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.runner) {
            log('Runner did not exit in 10s, sending SIGKILL');
            this.runner.kill('SIGKILL');
          }
          resolve();
        }, 10000);

        if (this.runner) {
          this.runner.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    process.exit(0);
  }

  // ── 状态查询 ─────────────────────────────────────────────

  getStatus() {
    return {
      state: currentState,
      runner: this.runner ? 'running' : 'stopped',
      pid: this.runner?.pid || null,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      workspace: WORKSPACE,
      pendingRequests: this.pending.size,
      subscribers: this.subscribers.size,
    };
  }
}

// ─── HTTP 请求体读取 ────────────────────────────────────────

function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        req.destroy();
        resolve(null); // 返回 null 表示超限
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * 解析并校验 JSON-RPC 请求体。
 * @returns {object|null} 解析后的消息，校验失败时返回 null 并写入错误响应。
 */
function parseAndValidateRpc(body, res) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return null;
  }
  if (!msg.jsonrpc || !msg.method || msg.id === undefined) {
    sendError(res, 400, 'Invalid JSON-RPC request: requires jsonrpc, method, id');
    return null;
  }
  return msg;
}

// ─── HTTP 响应工具 ──────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx 不缓冲
  });
  res.flushHeaders();
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// ─── 路由解析 ───────────────────────────────────────────────

function parseRoute(req) {
  const url = new URL(req.url, `http://localhost:${SIDECAR_PORT}`);
  return { method: req.method, pathname: url.pathname };
}

// ─── HTTP Server ────────────────────────────────────────────

function createServer(mux) {
  const server = http.createServer(async (req, res) => {
    const { method, pathname } = parseRoute(req);
    const url = new URL(req.url, `http://localhost:${SIDECAR_PORT}`);

    try {
      // ── GET /health ──
      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, mux.getStatus());
        return;
      }

      // ══════════════════════════════════════════════════════════
      // 文件 API（任何状态都可用）
      // ══════════════════════════════════════════════════════════

      // ── GET /files?path=xxx — 读取文件 ──
      if (method === 'GET' && pathname === '/files') {
        const reqPath = url.searchParams.get('path');
        const { safe, resolved, error } = validatePath(reqPath);
        if (!safe) {
          sendError(res, 400, error);
          return;
        }

        try {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            // 列出目录内容
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            const items = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined,
            }));
            sendJson(res, 200, { type: 'directory', path: reqPath, items });
          } else {
            // 读取文件内容
            const content = fs.readFileSync(resolved, 'utf-8');
            sendJson(res, 200, { type: 'file', path: reqPath, content, size: stat.size });
          }
        } catch (err) {
          if (err.code === 'ENOENT') {
            sendError(res, 404, 'File not found');
          } else {
            sendError(res, 500, err.message);
          }
        }
        return;
      }

      // ── GET /files/search?pattern=xxx — 搜索文件 ──
      if (method === 'GET' && pathname === '/files/search') {
        const pattern = url.searchParams.get('pattern') || '*';
        const maxResults = parseInt(url.searchParams.get('max') || '100', 10);

        const results = searchFiles(WORKSPACE, pattern, maxResults);
        sendJson(res, 200, { pattern, results, count: results.length });
        return;
      }

      // ── POST /files?path=xxx — 写入文件 ──
      if (method === 'POST' && pathname === '/files') {
        const reqPath = url.searchParams.get('path');
        const { safe, resolved, error } = validatePath(reqPath);
        if (!safe) {
          sendError(res, 400, error);
          return;
        }

        const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
        if (body === null) {
          sendError(res, 413, 'Request body too large');
          return;
        }

        try {
          // 确保父目录存在
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, body, 'utf-8');
          sendJson(res, 200, { success: true, path: reqPath, size: Buffer.byteLength(body) });
        } catch (err) {
          sendError(res, 500, err.message);
        }
        return;
      }

      // ── PUT /files?path=xxx — 创建目录 ──
      if (method === 'PUT' && pathname === '/files') {
        const reqPath = url.searchParams.get('path');
        const { safe, resolved, error } = validatePath(reqPath);
        if (!safe) {
          sendError(res, 400, error);
          return;
        }

        try {
          fs.mkdirSync(resolved, { recursive: true });
          sendJson(res, 200, { success: true, path: reqPath, type: 'directory' });
        } catch (err) {
          sendError(res, 500, err.message);
        }
        return;
      }

      // ── DELETE /files?path=xxx — 删除文件或目录 ──
      if (method === 'DELETE' && pathname === '/files') {
        const reqPath = url.searchParams.get('path');
        const { safe, resolved, error } = validatePath(reqPath);
        if (!safe) {
          sendError(res, 400, error);
          return;
        }

        try {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            fs.rmSync(resolved, { recursive: true });
          } else {
            fs.unlinkSync(resolved);
          }
          sendJson(res, 200, { success: true, path: reqPath });
        } catch (err) {
          if (err.code === 'ENOENT') {
            sendError(res, 404, 'File not found');
          } else {
            sendError(res, 500, err.message);
          }
        }
        return;
      }

      // ══════════════════════════════════════════════════════════
      // Runner 管理 API
      // ══════════════════════════════════════════════════════════

      // ── POST /runner/start ──
      if (method === 'POST' && pathname === '/runner/start') {
        if (mux.runner) {
          sendJson(res, 200, { success: true, message: 'Runner already running', state: currentState });
        } else {
          mux.startRunner();
          sendJson(res, 200, { success: true, message: 'Runner starting', state: currentState });
        }
        return;
      }

      // ── POST /runner/stop ──
      if (method === 'POST' && pathname === '/runner/stop') {
        if (!mux.runner) {
          sendJson(res, 200, { success: true, message: 'Runner not running', state: currentState });
        } else {
          mux.stopRunner();
          sendJson(res, 200, { success: true, message: 'Runner stopping', state: currentState });
        }
        return;
      }

      // ── POST /runner/restart ──
      if (method === 'POST' && pathname === '/runner/restart') {
        mux.restartRunner();
        sendJson(res, 200, { success: true, message: 'Runner restarting', state: currentState });
        return;
      }

      // ══════════════════════════════════════════════════════════
      // RPC API（仅 ready 状态可用）
      // ══════════════════════════════════════════════════════════

      // ── GET /rpc/stream — 长连接 SSE 订阅 ──
      if (method === 'GET' && pathname === '/rpc/stream') {
        if (currentState !== State.READY) {
          sendError(res, 503, `Runner not ready, current state: ${currentState}`);
          return;
        }
        sendSseHeaders(res);
        mux.addSubscriber(res);
        // 发送初始心跳
        res.write(': connected\n\n');
        return;
      }

      // ── POST /rpc — 流式 SSE 响应 ──
      if (method === 'POST' && pathname === '/rpc') {
        if (currentState !== State.READY) {
          sendError(res, 503, `Runner not ready, current state: ${currentState}`);
          return;
        }

        const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
        if (body === null) {
          sendError(res, 413, 'Request body too large');
          return;
        }

        const msg = parseAndValidateRpc(body, res);
        if (!msg) return;

        sendSseHeaders(res);

        try {
          await mux.enqueuePrompt(() => mux.sendStreaming(msg, res));
        } catch (err) {
          // 超时或 runner 不可用
          if (!res.writableEnded) {
            mux._writeSseEvent(res, 'error', {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: err.message },
            });
            res.end();
          }
        }
        return;
      }

      // ── POST /rpc/fire-and-forget — 一次性 JSON 响应 ──
      if (method === 'POST' && pathname === '/rpc/fire-and-forget') {
        if (currentState !== State.READY) {
          sendError(res, 503, `Runner not ready, current state: ${currentState}`);
          return;
        }

        const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
        if (body === null) {
          sendError(res, 413, 'Request body too large');
          return;
        }

        const msg = parseAndValidateRpc(body, res);
        if (!msg) return;

        try {
          const result = await mux.send(msg);
          sendJson(res, 200, result);
        } catch (err) {
          if (err.message.includes('timeout')) {
            sendError(res, 504, err.message);
          } else {
            sendError(res, 502, err.message);
          }
        }
        return;
      }

      // ── POST /shutdown ──
      if (method === 'POST' && pathname === '/shutdown') {
        sendJson(res, 200, { status: 'shutting_down' });
        // 异步关闭，先让响应发出去
        setImmediate(() => mux.shutdown());
        return;
      }

      // ── 404 ──
      sendError(res, 404, `Not found: ${method} ${pathname}`);
    } catch (err) {
      logError(`Unhandled error: ${err.message}`);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    }
  });

  return server;
}

// ─── 主入口 ─────────────────────────────────────────────────

function main() {
  log('ACP Sidecar starting...');
  log(`  RUNNER_CMD:               ${RUNNER_CMD}`);
  log(`  SIDECAR_PORT:             ${SIDECAR_PORT}`);
  log(`  WORKSPACE:                ${WORKSPACE}`);
  log(`  RUNNER_STARTUP_TIMEOUT:   ${RUNNER_STARTUP_TIMEOUT_MS}ms`);
  log(`  MAX_REQUEST_BODY_BYTES:   ${MAX_REQUEST_BODY_BYTES}`);
  log(`  AUTO_RESTART:             ${AUTO_RESTART}`);
  log(`  REQUEST_TIMEOUT_SEC:      ${REQUEST_TIMEOUT_SEC}`);
  log(`  PROMPT_SERIAL:            ${PROMPT_SERIAL}`);

  const mux = new JsonRpcMultiplexer();
  const server = createServer(mux);

  // 先启动 HTTP server，再启动 runner
  server.listen(SIDECAR_PORT, '0.0.0.0', () => {
    log(`HTTP server listening on 0.0.0.0:${SIDECAR_PORT}`);
    mux.startRunner();
  });

  server.on('error', (err) => {
    logError(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  // 信号处理
  const handleSignal = (signal) => {
    log(`Received ${signal}`);
    mux.shutdown();
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // 未捕获异常
  process.on('uncaughtException', (err) => {
    logError(`Uncaught exception: ${err.message}\n${err.stack}`);
    mux.shutdown();
  });

  process.on('unhandledRejection', (reason) => {
    logError(`Unhandled rejection: ${reason}`);
  });
}

main();
