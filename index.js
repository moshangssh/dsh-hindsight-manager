/** Hindsight 工作区配置面板；通过上游显式 runtime API 注册会话工具和生命周期。 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createDshRuntime } from './vendor/hindsight-coding-agents/dist/dsh.js';

export const name = 'hindsight-manager';
export const inject = ['agents', 'tools'];

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

/** 目录 dir 是否落在 root 之内（含相等）。 */
function isWithin(dir, root) {
  if (!root) return false;
  if (root === '/') return true;
  const a = normalizeDir(dir);
  const b = normalizeDir(root);
  return a === b || a.startsWith(b + '/');
}

function readConfigFile(configPath) {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
}

/** 取 dsh 段；兼容把字段直接写在根上的旧格式。 */
function dshSection(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const section = raw.harnesses?.dsh;
  if (section && typeof section === 'object') return section;
  return raw;
}

function readSettings(configPath) {
  const raw = readConfigFile(configPath);
  const section = dshSection(raw);
  const mapPathToBank = section.mapPathToBank && typeof section.mapPathToBank === 'object' ? section.mapPathToBank : {};
  return {
    configPath,
    exists: existsSync(configPath),
    serverMode: raw.serverMode ?? 'cloud',
    apiUrl: section.apiUrl ?? raw.apiUrl ?? '',
    apiTokenConfigured: Boolean(section.apiToken ?? raw.apiToken),
    optInOnly: section.optInOnly !== false,
    optInPaths: Array.isArray(section.optInPaths) ? section.optInPaths : [],
    autoInject: section.autoInject ?? 'recall',
    retainSessions: section.retainSessions !== false,
    autoSeed: Boolean(section.autoSeed),
    autoUpdate: section.autoUpdate !== false,
    positions: Object.entries(mapPathToBank).map(([dir, bank]) => ({ dir: normalizeDir(dir), bank: String(bank) })),
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
  const isNewShape = raw.harnesses?.dsh && typeof raw.harnesses.dsh === 'object';
  const section = isNewShape ? raw.harnesses.dsh : (raw.harnesses = { ...(raw.harnesses ?? {}), dsh: {} }).harnesses.dsh;

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
  for (const key of ['autoInject', 'apiUrl', 'apiToken']) {
    if (typeof patch[key] === 'string' && patch[key].trim() !== '') section[key] = patch[key].trim();
  }
  for (const key of ['retainSessions', 'autoSeed', 'autoUpdate']) {
    if (typeof patch[key] === 'boolean') section[key] = patch[key];
  }
  writeConfigFile(configPath, raw);
  return readSettings(configPath);
}

// ---------------------------------------------------------------------------
// 工作区 → bank 解析（与上游同一套规则，但显式传入目录，不读 process.cwd）
// ---------------------------------------------------------------------------

/**
 * 解析某个目录对应的 bank。
 * 顺序与上游一致：mapPathToBank 最长前缀 → optInPaths 视为已批准（用动态库名）→ 未批准则 undefined。
 * @param dir - 会话工作目录
 * @param settings - readSettings() 的结果
 * @returns {{bank: string, reason: string}|{bank: undefined, reason: string}}
 */
function resolveBankFor(dir, settings) {
  const target = normalizeDir(dir);

  let best;
  for (const entry of settings.positions) {
    if (!isWithin(target, entry.dir)) continue;
    if (!best || entry.dir.length > best.dir.length) best = entry;
  }
  if (best) return { bank: best.bank, reason: `mapped:${best.dir}` };

  if (!settings.optInOnly) {
    // 未映射但全局放行：用动态库名，与上游 bankIdTemplate 的默认值一致
    return { bank: `coding-agent::${basenameOf(target)}`, reason: 'optInOnly=false' };
  }
  for (const opted of settings.optInPaths.map(normalizeDir)) {
    if (isWithin(target, opted)) return { bank: `coding-agent::${basenameOf(target)}`, reason: `optInPath:${opted}` };
  }
  return { bank: undefined, reason: 'not-opted-in' };
}

function basenameOf(dir) {
  const parts = normalizeDir(dir).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'root';
}

export function apply(ctx, config = {}) {
  const configPath = process.env.HINDSIGHT_CONFIG || join(homedir(), '.hindsight', 'coding-agent.json');
  const readCurrentSettings = () => readSettings(configPath);
  const runtime = createDshRuntime();
  const log = (level, message) => {
    ctx.logger?.[level]?.(`[hindsight-manager] ${message}`);
    if (config.verbose) console.error(`[hindsight-manager] ${message}`);
  };

  ctx.effect(() => () => runtime.dispose(), 'hindsight-manager: runtime');
  ctx.on('agent/created', runtime.hooks.sessionStart);
  ctx.on('agent/pre-step', runtime.hooks.preStep, { prepend: true });
  ctx.on('agent/turn-stopping', runtime.hooks.turnStopping);
  ctx.on('agent/disposed', runtime.hooks.disposed);

  let unregister = [];
  const refreshTools = () => {
    for (const dispose of unregister) dispose();
    unregister = [];
    const current = readCurrentSettings();
    const roots = [
      ...current.positions.map(({ dir }) => dir),
      ...current.optInPaths,
      ...(!current.optInOnly ? [dirname(configPath)] : []),
    ];
    const definitions = roots.map((root) => runtime.toolDefinitions(root)).find((tools) => tools.length) ?? [];
    unregister = definitions.map((definition) => ctx.tools.register(definition, {
      when: ({ agent }) => runtime.workspaceForAgent(agent) !== undefined,
    }));
    log('info', `注册 ${definitions.length} 个会话级 hindsight 工具`);
  };
  ctx.effect(() => {
    refreshTools();
    return () => {
      for (const dispose of unregister) dispose();
    };
  }, 'hindsight-manager: tools');

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
        if (size > 1 << 20) {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}/v1/default/banks/${encodeURIComponent(bank)}/documents?limit=1`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, status: response.status, error: (await response.text()).slice(0, 300) };
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
      return { ok: false, error: error?.name === 'AbortError' ? '连接超时' : String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  };

  /** 列出服务器上真实存在的 bank，供 GUI 下拉选择。 */
  const listBanks = async () => {
    const current = readCurrentSettings();
    if (!current.apiUrl) return { ok: false, error: '配置里没有 apiUrl' };
    const base = current.apiUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}/v1/default/banks`, { signal: controller.signal });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, banks: [] };
      const body = await response.json();
      const rows = Array.isArray(body) ? body : (body?.items ?? body?.banks ?? []);
      const banks = rows
        .map((row) => (typeof row === 'string' ? row : row?.bank_id ?? row?.id ?? row?.name))
        .filter((value) => typeof value === 'string' && value.length);
      return { ok: true, banks };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), banks: [] };
    } finally {
      clearTimeout(timer);
    }
  };

  // 浏览器侧鉴权：与 image-gen / mcp-management 同一套。缺失时 fail-open 到
  // 广播给所有本地请求，但拒绝一切带外部来源的写请求，避免匿名改配置。
  let webAdmission;
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      webAdmission = (request) => connectionCtx.connection.requestRejection(request);
    } catch {
      webAdmission = undefined;
    }
  });

  ctx.inject(['webServer'], (webCtx) => {
    /** 包一层鉴权：有 connection 就用它的判定，否则至少拒绝跨站写。 */
    const guard = (handler, { mutating }) => (req, res) => {
      const rejection = webAdmission?.(req);
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
        return;
      }
      if (webAdmission === undefined && mutating) {
        // 没有鉴权服务时，写操作只接受同源请求
        const origin = req.headers?.origin;
        const host = req.headers?.host;
        if (origin && host && !origin.endsWith(`//${host}`)) {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
      }
      return handler(req, res);
    };

    const register = (path, handler, options = { mutating: false }) =>
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler: guard(handler, options) }),
        `hindsight-manager: ${path}`,
      );

    register(ACTION_ROUTES.state, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const current = readCurrentSettings();
      // 附上每个映射目录的实时解析结果，让面板能显示「现在生效的是哪个库」
      const positions = current.positions.map((entry) => ({
        ...entry,
        exists: existsSync(entry.dir),
        resolved: resolveBankFor(entry.dir, current).bank ?? null,
      }));
      sendJson(res, 200, { ...current, positions });
    });

    register(
      ACTION_ROUTES.test,
      async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        sendJson(res, 200, await probeConnection());
      },
      { mutating: true },
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
          await runtime.refresh();
          refreshTools();
          log('info', '配置已更新，工作区运行时和工具已刷新');
          sendJson(res, 200, {
            ok: true,
            settings: next,
            note: '保存完成后，后续工具调用和会话步骤使用新配置；已开始的请求按原配置完成。',
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
      { mutating: true },
    );
  });


}

export default { name, inject, apply };
