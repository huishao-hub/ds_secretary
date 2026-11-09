// 服务入口：装配 DB / 调度器 / AI / HTTP，管理生命周期。
// 用法：node service/index.mjs [--data-dir D:\AI-Secretary\data] [--port 0]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, readPrefs } from './db.mjs';
import { createScheduler } from './reminders.mjs';
import { createAI, loadAiKey } from './ai.mjs';
import { createHttpServer } from './http.mjs';
import { fmtStamp, nowStamp, TZ } from './time.mjs';

export const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
export const BRIDGE_FILENAME = 'bridge.json';

// ---------------------------------------------------------------------------
// 日志：只写文件，绝不打印密钥
// ---------------------------------------------------------------------------

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(logDir, { console: toConsole = false, debug = false, maxBytes = 5 * 1024 * 1024 } = {}) {
  const file = path.join(logDir, 'service.log');
  const minLevel = debug ? LOG_LEVELS.debug : LOG_LEVELS.info;
  let size = 0;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    size = fs.statSync(file).size;
  } catch {
    /* 目录不可写时退化为只输出到控制台 */
  }
  return (level, message) => {
    const weight = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (weight < minLevel) return;
    const line = `[${fmtStamp(new Date())}] [${level}] ${message}\n`;
    try {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size + bytes > maxBytes) {
        try {
          fs.rmSync(`${file}.1`, { force: true });
        } catch {
          /* ignore */
        }
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          /* ignore */
        }
        size = 0;
      }
      fs.appendFileSync(file, line, 'utf8');
      size += bytes;
    } catch {
      /* 日志失败绝不能影响请求 */
    }
    if (toConsole && weight >= LOG_LEVELS.warn) {
      try {
        process.stderr.write(line);
      } catch {
        /* ignore */
      }
    }
  };
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readBridge(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createService
// ---------------------------------------------------------------------------

/**
 * 启动服务。返回 { port, token, close() }（另附 server/db/dataDir/bridgePath 便于调试）。
 * @param {{dataDir?:string, port?:number, aiKey?:string|null, logDir?:string,
 *          tickMs?:number, aiTimeoutMs?:number, verbose?:boolean}} options
 */
export async function createService(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(PROJECT_ROOT, 'data'));
  const logDir = path.resolve(options.logDir || path.join(dataDir, 'logs'));
  const port = Number.isInteger(options.port) ? options.port : 0;
  const tickMs = Number(options.tickMs) > 0 ? Number(options.tickMs) : 20000;
  const startedAt = new Date();
  const log = createLogger(logDir, { console: options.verbose === true, debug: options.verbose === true });

  fs.mkdirSync(dataDir, { recursive: true });

  const aiKey =
    options.aiKey !== undefined
      ? options.aiKey
      : loadAiKey({ configPath: path.join(HERE, 'config.local.json') });

  const { db, dbPath } = openDb(dataDir);
  const bridgePath = path.join(dataDir, BRIDGE_FILENAME);
  const token = crypto.randomBytes(32).toString('hex'); // 64 位 hex
  const prefsRef = () => readPrefs(db);

  const ai = createAI({
    db,
    prefsRef,
    log,
    aiKey,
    timeoutMs: Number(options.aiTimeoutMs) > 0 ? Number(options.aiTimeoutMs) : 15000,
    ...(options.aiEndpoint ? { endpoint: String(options.aiEndpoint) } : {}),
  });

  const scheduler = createScheduler({ db, prefsRef, log, tickMs });

  const ctx = {
    db,
    dbPath,
    ai,
    log,
    version: VERSION,
    startedAt,
    token,
    scheduler,
  };
  const { server } = createHttpServer(ctx);

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  }).catch((err) => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  });

  const actualPort = server.address().port;
  const bridge = {
    port: actualPort,
    token,
    pid: process.pid,
    startedAt: nowStamp(startedAt),
    version: VERSION,
  };
  try {
    writeJsonAtomic(bridgePath, bridge);
  } catch (err) {
    // bridge.json 写不出来等于桌宠发现不了服务：关闭已开的资源再失败
    log('error', `failed to write bridge.json: ${err && err.message ? err.message : err}`);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  scheduler.start();

  let closed = false;
  let closingPromise = null;

  async function close() {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      if (closed) return;
      closed = true;
      try {
        scheduler.stop();
      } catch (err) {
        log('error', `scheduler stop failed: ${err && err.message ? err.message : err}`);
      }
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          server.close(finish);
        } catch {
          finish();
        }
        // 有 keep-alive 连接时 server.close 可能迟迟不回调
        const t = setTimeout(finish, 2000);
        if (typeof t.unref === 'function') t.unref();
      });
      // 只有 bridge.json 还是本次进程写的才删除，避免误删新实例的文件
      const current = readBridge(bridgePath);
      if (current && current.pid === process.pid && current.token === token) {
        try {
          fs.rmSync(bridgePath, { force: true });
        } catch (err) {
          log('warn', `failed to remove bridge.json: ${err && err.message ? err.message : err}`);
        }
      }
      try {
        db.close();
      } catch (err) {
        log('error', `db close failed: ${err && err.message ? err.message : err}`);
      }
      log('info', 'service closed');
    })();
    return closingPromise;
  }

  // process.on('exit') 阶段的同步兜底
  function cleanupSync() {
    try {
      scheduler.stop();
    } catch {
      /* ignore */
    }
    try {
      const current = readBridge(bridgePath);
      if (current && current.pid === process.pid) fs.rmSync(bridgePath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }

  log('info', `service started on 127.0.0.1:${actualPort} (db=${dbPath}, ai=${ai.mode}, tz=${TZ})`);

  return {
    port: actualPort,
    token,
    close,
    cleanupSync,
    server,
    db,
    dbPath,
    bridgePath,
    dataDir,
    logDir,
    ai,
    scheduler,
    version: VERSION,
    startedAt,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--log-dir') out.logDir = argv[++i];
    else if (arg === '--tick-ms') out.tickMs = Number(argv[++i]);
    else if (arg === '--verbose') out.verbose = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node service/index.mjs [--data-dir D:\\AI-Secretary\\data] [--port 0] [--log-dir DIR] [--verbose]\n',
    );
    process.exit(0);
  }

  const resolvedDataDir = path.resolve(args.dataDir || path.join(PROJECT_ROOT, 'data'));
  const service = await createService({
    dataDir: resolvedDataDir,
    port: Number.isInteger(args.port) ? args.port : 0,
    logDir: args.logDir || path.join(path.dirname(resolvedDataDir), 'logs'),
    tickMs: args.tickMs,
    verbose: true,
  }).catch((err) => {
    process.stderr.write(`service failed to start: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });

  process.stdout.write(`AI-Secretary service listening on 127.0.0.1:${service.port}\n`);
  process.stdout.write(`bridge: ${service.bridgePath}\n`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.cleanupSync();
    process.stdout.write(`received ${signal}, shutting down\n`);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('exit', () => {
    try {
      service.cleanupSync();
    } catch {
      /* ignore */
    }
  });

  // 桌面托管场景：任何未捕获异常都只记日志，进程继续活着
  process.on('uncaughtException', (err) => {
    service.log('error', `uncaughtException: ${err && err.stack ? err.stack : err}`);
  });
  process.on('unhandledRejection', (reason) => {
    service.log(
      'error',
      `unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`,
    );
  });
}
