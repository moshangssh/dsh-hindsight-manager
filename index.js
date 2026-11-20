/** 官方 Hindsight 插件的配置面板。记忆运行时由 DSH 中安装的官方插件负责。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import managerConfig from './manager.config.json' with { type: 'json' };

export const name = 'hindsight-manager';
export const inject = ['webServer', 'connection'];

const ACTION_ROUTES = {
  state: '/plugins/dsh-hindsight-manager/state',
  test: '/plugins/dsh-hindsight-manager/test',
  save: '/plugins/dsh-hindsight-manager/save',
  banks: '/plugins/dsh-hindsight-manager/banks',
};

// ---------------------------------------------------------------------------
// 配置读写（~/.hindsight/coding-agent.json 是权威来源）
// ---------------------------------------------------------------------------

/** 规范化目录：展开 ~、去掉尾部斜杠。 */
function normalizeDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return '';
  const expanded = dir === '~' || dir.startsWith('~/') ? join(homedir(), dir.slice(1)) : dir;
  return resolve(expanded).replace(/\/+$/, '') || '/';
}

function readConfigFile(configPath) {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
}

/** 配置文件顶层与 harnesses.dsh 的字段继承，与官方配置格式一致。 */
function dshSettings(configPath) {
  const raw = readConfigFile(configPath);
  return { ...managerConfig.formDefaults, ...raw, ...raw.harnesses?.dsh };
}

function serviceUrl(section) {
  return section.serverMode === 'daemon' ? `http://127.0.0.1:${section.apiPort}` : section.apiUrl;
}

function readSettings(configPath) {
  const section = dshSettings(configPath);
  return {
    configPath,
    exists: existsSync(configPath),
    serverMode: section.serverMode,
    apiUrl: serviceUrl(section),
    apiTokenConfigured: Boolean(section.apiToken),
    optInOnly: section.optInOnly,
    optInPaths: section.optInPaths,
    retainSessions: section.retainSessions,
    positions: Object.entries(section.mapPathToBank).map(([dir, bank]) => ({
      dir: normalizeDir(dir), bank, exists: existsSync(normalizeDir(dir)),
    })),
  };
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
function writeConfigFile(configPath, next) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);
}

/**
 * 按 GUI 提交的内容写回配置。只改本插件负责的字段，其余原样保留。
 * @param patch - positions（数组）、optInOnly、optInPaths、autoInject、retainSessions、apiUrl
 */
function saveSettings(configPath, patch) {
  const raw = readConfigFile(configPath);
  const current = { ...managerConfig.formDefaults, ...raw, ...raw.harnesses?.dsh };
  raw.harnesses ??= {};
  const section = raw.harnesses.dsh ??= {};

  if (Array.isArray(patch.positions)) {
    const map = {};
    for (const entry of patch.positions) {
      const dir = normalizeDir(entry?.dir);
      const bank = typeof entry?.bank === 'string' ? entry.bank.trim() : '';
      if (!dir || !bank) continue;
      map[dir] = bank;
    }
    section.mapPathToBank = map;
  }
  if (typeof patch.optInOnly === 'boolean') section.optInOnly = patch.optInOnly;
  if (Array.isArray(patch.optInPaths)) {
    section.optInPaths = patch.optInPaths.map(normalizeDir).filter(Boolean);
  }
  if (typeof patch.apiUrl === 'string' && patch.apiUrl.trim() !== '') {
    section.apiUrl = patch.apiUrl.trim();
    if (current.serverMode === 'daemon' && section.apiUrl.replace(/\/+$/, '') !== serviceUrl(current)) {
      section.serverMode = 'self-hosted';
    }
  }
  for (const key of ['autoInject', 'apiToken']) {
    if (typeof patch[key] === 'string' && patch[key].trim() !== '') section[key] = patch[key].trim();
  }
  if (typeof patch.retainSessions === 'boolean') section.retainSessions = patch.retainSessions;
  writeConfigFile(configPath, raw);
  return readSettings(configPath);
}

export function apply(ctx, config = {}) {
  const settings = { ...managerConfig, ...config };
  const configPath = normalizeDir(settings.configPath);
  const readCurrentSettings = () => readSettings(configPath);
  const requestOptions = () => {
    const { apiToken } = dshSettings(configPath);
    return {
      signal: AbortSignal.timeout(settings.requestTimeoutMs),
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
    };
  };

  // ---- GUI 路由 -----------------------------------------------------------

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolveBody) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > settings.maxRequestBytes) {
          resolveBody(undefined);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          resolveBody(undefined);
        }
      });
      req.on('error', () => resolveBody(undefined));
    });

  /** 调上游 REST 探活：故意用文档列表而不是 /health，能同时验证 base 与鉴权。 */
  const probeConnection = async () => {
    const current = readCurrentSettings();
    if (!current.apiUrl) return { ok: false, error: '配置里没有 apiUrl' };
    const base = current.apiUrl.replace(/\/+$/, '');
    const bank = current.positions[0]?.bank;
    if (!bank) return { ok: false, error: '尚未映射任何工作区，无法测试具体 bank' };
    try {
      const response = await fetch(`${base}/v1/default/banks/${encodeURIComponent(bank)}/documents?limit=1`, requestOptions());
      if (!response.ok) {
        return { ok: false, status: response.status, error: (await response.text()).slice(0, settings.errorPreviewChars) };
      }
      const body = await response.json();
      // 带 /mcp 之类的前缀会让路由兜底成 {}：这是最隐蔽的失败模式，必须显式识别
      if (body && typeof body === 'object' && Object.keys(body).length === 0) {
        return {
          ok: false,
          error: `返回了空对象：${base} 可能不是 REST 根（例如多了 /mcp 后缀）`,
        };
      }
      return { ok: true, status: response.status, bank, documents: Array.isArray(body?.items) ? body.items.length : undefined };
    } catch (error) {
      return { ok: false, error: error?.name === 'TimeoutError' ? '连接超时' : String(error?.message ?? error) };
    }
  };

  /** 列出服务器上真实存在的 bank，供 GUI 下拉选择。 */
  const listBanks = async () => {
    const current = readCurrentSettings();
    if (!current.apiUrl) return { ok: false, error: '配置里没有 apiUrl' };
    const base = current.apiUrl.replace(/\/+$/, '');
    try {
      const response = await fetch(`${base}/v1/default/banks`, requestOptions());
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, banks: [] };
      const body = await response.json();
      const rows = Array.isArray(body) ? body : (body?.items ?? body?.banks ?? []);
      const banks = rows
        .map((row) => (typeof row === 'string' ? row : row?.bank_id ?? row?.id ?? row?.name))
        .filter((value) => typeof value === 'string' && value.length);
      return { ok: true, banks };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), banks: [] };
    }
  };

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const register = (path, handler) => webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact', path,
        handler(req, res) {
          const rejection = webCtx.connection.requestRejection(req);
          if (rejection !== undefined) {
            sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
            return;
          }
          return handler(req, res);
        },
      }),
      `hindsight-manager: ${path}`,
    );

    register(ACTION_ROUTES.state, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      sendJson(res, 200, readCurrentSettings());
    });

    register(
      ACTION_ROUTES.test,
      async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        sendJson(res, 200, await probeConnection());
      },
    );

    register(ACTION_ROUTES.banks, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      sendJson(res, 200, await listBanks());
    });

    register(
      ACTION_ROUTES.save,
      async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const patch = await readBody(req);
        if (!patch) return sendJson(res, 400, { error: '请求体不是合法 JSON' });
        try {
          const next = saveSettings(configPath, patch);
          sendJson(res, 200, {
            ok: true,
            settings: next,
            restartRequired: true,
            note: '配置已保存，请重启 DSH，让官方 Hindsight 插件加载新配置。',
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    );
  });
}

export default { name, inject, apply };
