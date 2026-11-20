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
  const path = dir.trim();
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  return resolve(expanded).replace(/\/+$/, '') || '/';
}

function readConfigFile(configPath) {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
}

const SETTING_KEYS = ['apiUrl', 'serverMode', 'apiPort', 'optInOnly', 'optInPaths', 'retainSessions',
  'autoInject', 'autoInjectEveryTurns', 'injectTimeoutMs', 'recallOptions'];
const RECALL_KEYS = ['types', 'budget', 'max_tokens'];
const selected = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const INHERIT_GROUPS = {
  connection: ['apiUrl', 'serverMode', 'apiPort'], positions: ['mapPathToBank'],
  optInOnly: ['optInOnly'], optInPaths: ['optInPaths'], retainSessions: ['retainSessions'],
  autoInject: ['autoInject', 'autoReflect'], autoInjectEveryTurns: ['autoInjectEveryTurns'],
  injectTimeoutMs: ['injectTimeoutMs'], recallOptions: ['recallOptions'],
};

/** 只读取关联产物的声明和参数，不导入运行时，也不检测进程状态。 */
function readEnhancement(settings) {
  const packagePath = normalizeDir(settings.officialPackagePath);
  const enhancement = {
    status: 'unlinked', packagePath, upstreamVersion: null, patchSetVersion: null,
    autoInjectEveryTurns: false, error: null,
  };
  if (!packagePath) return { enhancement, policy: {} };
  try {
    const installed = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    const expected = settings.supportedEnhancement;
    if (installed.name !== expected.upstream.name) throw new Error('关联目录不是支持的官方 Hindsight 包');
    enhancement.upstreamVersion = installed.version;
    const declarationPath = join(packagePath, settings.declarationFile);
    if (!existsSync(declarationPath)) return { enhancement: { ...enhancement, status: 'undeclared' }, policy: {} };
    const declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
    if (!isObject(declaration) || !isObject(declaration.upstream)
      || declaration.upstream.name !== installed.name || declaration.upstream.version !== installed.version
      || installed.version !== expected.upstream.version || declaration.patchSetVersion !== expected.patchSetVersion
      || declaration.defaultsFile !== expected.defaultsFile
      || typeof declaration.capabilities?.autoInjectEveryTurns !== 'boolean') {
      throw new Error('增强声明与关联包或当前支持基线不一致');
    }
    const policy = JSON.parse(readFileSync(join(packagePath, declaration.defaultsFile), 'utf8'));
    if (!isObject(policy)) throw new Error('增强参数文件必须是 JSON 对象');
    return {
      enhancement: { ...enhancement, status: 'declared', patchSetVersion: declaration.patchSetVersion,
        autoInjectEveryTurns: declaration.capabilities.autoInjectEveryTurns },
      policy,
    };
  } catch (error) {
    return { enhancement: { ...enhancement, status: 'error', error: String(error.message) }, policy: {} };
  }
}

function resolveSettings(raw, settings) {
  const result = { ...settings.formDefaults, ...raw };
  result.serverMode = ['cloud', 'self-hosted', 'daemon'].includes(raw.serverMode) ? raw.serverMode : settings.formDefaults.serverMode;
  result.apiPort = raw.apiPort || settings.formDefaults.apiPort;
  result.apiUrl = raw.apiUrl ?? settings.formDefaults.apiUrl;
  result.apiUrl = serviceUrl(result);
  result.autoInject = settings.options.autoInjectModes.includes(raw.autoInject) ? raw.autoInject
    : raw.autoReflect === false ? 'none' : settings.formDefaults.autoInject;
  result.injectTimeoutMs = raw.injectTimeoutMs || settings.formDefaults.injectTimeoutMs;
  result.retainSessions = raw.retainSessions ?? settings.formDefaults.retainSessions;
  result.optInOnly = raw.optInOnly ?? settings.formDefaults.optInOnly;
  result.recallOptions = selected({ ...settings.recallDefaults,
    ...(raw.recallOptions && typeof raw.recallOptions === 'object' && !Array.isArray(raw.recallOptions) ? raw.recallOptions : {}),
  }, RECALL_KEYS);
  return result;
}

function displayValues(section) {
  return {
    ...selected(section, SETTING_KEYS),
    positions: Object.entries(section.mapPathToBank ?? {}).map(([dir, bank]) => ({
      dir: normalizeDir(dir), bank, exists: existsSync(normalizeDir(dir)),
    })),
  };
}

/** 原始配置先合并，默认值在解析展示值时补齐。 */
function dshSettings(configPath, settings = managerConfig) {
  const raw = readConfigFile(configPath);
  const { policy } = readEnhancement(settings);
  return resolveSettings({ ...policy, ...raw, ...raw.harnesses?.dsh }, settings);
}

function serviceUrl(section) {
  return section.serverMode === 'daemon' ? `http://127.0.0.1:${section.apiPort}` : section.apiUrl;
}

function readSettings(configPath, settings = managerConfig) {
  const raw = readConfigFile(configPath);
  const { policy, enhancement } = readEnhancement(settings);
  const merged = { ...policy, ...raw, ...raw.harnesses?.dsh };
  const section = resolveSettings(merged, settings);
  const inherited = resolveSettings({ ...policy, ...raw }, settings);
  const sourceFor = (key) => ({
    layer: Object.hasOwn(raw.harnesses?.dsh ?? {}, key) ? 'dsh' : Object.hasOwn(raw, key) ? 'global'
      : Object.hasOwn(policy, key) ? 'policy' : 'default', key,
  });
  const overrides = {};
  const sources = {};
  for (const key of SETTING_KEYS) {
    overrides[key] = Object.hasOwn(raw.harnesses?.dsh ?? {}, key);
    sources[key] = sourceFor(key);
  }
  overrides.positions = Object.hasOwn(raw.harnesses?.dsh ?? {}, 'mapPathToBank');
  sources.positions = sourceFor('mapPathToBank');
  overrides.autoInject ||= Object.hasOwn(raw.harnesses?.dsh ?? {}, 'autoReflect');
  if (!settings.options.autoInjectModes.includes(merged.autoInject)) {
    sources.autoInject = Object.hasOwn(merged, 'autoReflect')
      ? sourceFor('autoReflect')
      : { layer: 'default', key: 'autoInject' };
  }
  const configured = selected(merged, [...SETTING_KEYS, 'autoReflect']);
  if (configured.recallOptions && typeof configured.recallOptions === 'object' && !Array.isArray(configured.recallOptions)) {
    configured.recallOptions = selected(configured.recallOptions, RECALL_KEYS);
  }
  if (Object.hasOwn(merged, 'mapPathToBank')) configured.positions = displayValues(section).positions;
  return {
    ...displayValues(section),
    configPath,
    exists: existsSync(configPath),
    apiTokenConfigured: Boolean(section.apiToken),
    overrides,
    sources,
    inherited: displayValues(inherited),
    configured,
    options: settings.options,
    enhancement,
  };
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
function writeConfigFile(configPath, next) {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);
}

class SettingsInputError extends Error {}
const invalid = (message) => { throw new SettingsInputError(message); };

/** 固定表单协议：set 修改值，inherit 删除覆盖；未提交字段保持原样。 */
function saveSettings(configPath, patch, settings = managerConfig) {
  if (!isObject(patch)) invalid('请求体必须是 set/inherit 对象');
  for (const key of Object.keys(patch)) {
    if (!['set', 'inherit'].includes(key)) invalid(`不支持的请求字段：${key}`);
  }
  const changes = Object.hasOwn(patch, 'set') ? patch.set : {};
  const inherit = Object.hasOwn(patch, 'inherit') ? patch.inherit : [];
  if (!isObject(changes)) invalid('set 必须是对象');
  if (!Array.isArray(inherit)) invalid('inherit 必须是设置名称数组');
  const editable = ['apiUrl', 'positions', 'optInOnly', 'optInPaths', 'retainSessions',
    'autoInject', 'autoInjectEveryTurns', 'injectTimeoutMs', 'recallOptions'];
  for (const key of Object.keys(changes)) {
    if (!editable.includes(key)) invalid(`不支持的设置：${key}`);
  }
  for (const group of inherit) {
    if (typeof group !== 'string' || !Object.hasOwn(INHERIT_GROUPS, group)) invalid(`不支持的继承设置：${String(group)}`);
    const changed = group === 'connection' ? Object.hasOwn(changes, 'apiUrl') : Object.hasOwn(changes, group);
    if (changed) invalid(`${group} 不能同时 set 和 inherit`);
  }

  const raw = readConfigFile(configPath);
  const { policy, enhancement } = readEnhancement(settings);
  const currentRaw = { ...policy, ...raw, ...raw.harnesses?.dsh };
  const current = resolveSettings(currentRaw, settings);
  const section = { ...raw.harnesses?.dsh };
  const previousSection = JSON.stringify(section);
  for (const group of inherit) {
    for (const key of INHERIT_GROUPS[group]) delete section[key];
  }

  for (const key of ['optInOnly', 'retainSessions']) {
    if (!Object.hasOwn(changes, key)) continue;
    if (typeof changes[key] !== 'boolean') invalid(`${key} 必须是布尔值`);
    section[key] = changes[key];
  }
  if (Object.hasOwn(changes, 'apiUrl')) {
    if (typeof changes.apiUrl !== 'string' || !changes.apiUrl.trim()) invalid('apiUrl 必须是非空地址');
    section.apiUrl = changes.apiUrl.trim();
    if (current.serverMode === 'daemon' && section.apiUrl.replace(/\/+$/, '') !== current.apiUrl.replace(/\/+$/, '')) {
      section.serverMode = 'self-hosted';
    }
  }
  if (Object.hasOwn(changes, 'positions')) {
    if (!Array.isArray(changes.positions)) invalid('positions 必须是映射数组');
    const mapped = new Map();
    const firstRows = new Map();
    for (const [index, entry] of changes.positions.entries()) {
      const dir = normalizeDir(entry?.dir);
      const bank = typeof entry?.bank === 'string' ? entry.bank.trim() : '';
      if (!dir) invalid(`映射第 ${index + 1} 行缺少 dir`);
      if (!bank) invalid(`映射第 ${index + 1} 行缺少 bank`);
      if (mapped.has(dir)) invalid(`映射第 ${index + 1} 行与第 ${firstRows.get(dir)} 行路径重复：${dir}`);
      mapped.set(dir, bank);
      firstRows.set(dir, index + 1);
    }
    const currentMappings = new Map(displayValues(current).positions.map(({ dir, bank }) => [dir, bank]));
    const unchanged = mapped.size === currentMappings.size
      && [...mapped].every(([dir, bank]) => currentMappings.get(dir) === bank);
    if (!unchanged) section.mapPathToBank = Object.fromEntries(mapped);
  }
  if (Object.hasOwn(changes, 'optInPaths')) {
    if (!Array.isArray(changes.optInPaths) || changes.optInPaths.some((value) => typeof value !== 'string' || !value.trim())) {
      invalid('optInPaths 必须是非空路径字符串数组');
    }
    section.optInPaths = changes.optInPaths.map(normalizeDir);
  }
  if (Object.hasOwn(changes, 'autoInject')) {
    if (!settings.options.autoInjectModes.includes(changes.autoInject)) invalid('autoInject 不是支持的自动召回方式');
    section.autoInject = changes.autoInject;
  }
  if (Object.hasOwn(changes, 'autoInjectEveryTurns')) {
    if (!Number.isInteger(changes.autoInjectEveryTurns) || changes.autoInjectEveryTurns < 0) {
      invalid('autoInjectEveryTurns 必须是非负整数');
    }
    if (enhancement.status !== 'declared' || !enhancement.autoInjectEveryTurns) invalid('未关联声明支持逐轮召回的增强产物');
    section.autoInjectEveryTurns = changes.autoInjectEveryTurns;
  }
  if (Object.hasOwn(changes, 'injectTimeoutMs')) {
    if (!Number.isInteger(changes.injectTimeoutMs) || changes.injectTimeoutMs <= 0) invalid('injectTimeoutMs 必须是正整数毫秒数');
    section.injectTimeoutMs = changes.injectTimeoutMs;
  }
  if (Object.hasOwn(changes, 'recallOptions')) {
    const recall = changes.recallOptions;
    if (!isObject(recall)) invalid('recallOptions 必须是对象');
    for (const key of Object.keys(recall)) {
      if (!RECALL_KEYS.includes(key)) invalid(`不支持的 recallOptions 设置：${key}`);
    }
    if (Object.hasOwn(recall, 'budget') && !settings.options.recallBudgets.includes(recall.budget)) invalid('recallOptions.budget 不是支持的检索预算');
    if (Object.hasOwn(recall, 'max_tokens') && (!Number.isInteger(recall.max_tokens) || recall.max_tokens <= 0)) invalid('recallOptions.max_tokens 必须是正整数');
    if (Object.hasOwn(recall, 'types') && recall.types !== null
      && (!Array.isArray(recall.types) || recall.types.some((value) => typeof value !== 'string'))) {
      invalid('recallOptions.types 必须是字符串数组或 null');
    }
    if (Object.keys(recall).length) {
      section.recallOptions = { ...(isObject(currentRaw.recallOptions) ? currentRaw.recallOptions : {}), ...recall };
    }
  }
  if (JSON.stringify(section) !== previousSection) {
    raw.harnesses = { ...raw.harnesses, dsh: section };
    writeConfigFile(configPath, raw);
  }
  return readSettings(configPath, settings);
}

export function apply(ctx, config = {}) {
  const settings = { ...managerConfig, ...config };
  const configPath = normalizeDir(settings.configPath);
  const readCurrentSettings = () => readSettings(configPath, settings);
  const requestOptions = () => {
    const { apiToken } = dshSettings(configPath, settings);
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
      const response = await fetch(`${base}/v1/default/banks?limit=${settings.bankListLimit}&offset=0`, requestOptions());
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, banks: [] };
      const body = await response.json();
      if (!Array.isArray(body?.banks) || body.banks.some((row) => typeof row?.bank_id !== 'string')
        || !['total', 'limit', 'offset'].every((key) => Number.isInteger(body[key]))) {
        return { ok: false, error: '库列表响应格式错误：需要 banks[].bank_id 和 total/limit/offset', banks: [] };
      }
      return { ok: true, banks: body.banks.map((row) => row.bank_id), total: body.total, limit: body.limit, offset: body.offset };
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
          const next = saveSettings(configPath, patch, settings);
          sendJson(res, 200, {
            ok: true,
            settings: next,
            restartRequired: true,
            note: '配置已保存，请重启 DSH，让官方 Hindsight 插件加载新配置。',
          });
        } catch (error) {
          sendJson(res, error instanceof SettingsInputError ? 400 : 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    );
  });
}

export default { name, inject, apply };
