window.__ModuleLoader__.load({
  id: 'dsh-hindsight-manager',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;

    const NS = 'hindsight-manager';

    const ROUTES = {
      state: '/plugins/dsh-hindsight-manager/state',
      test: '/plugins/dsh-hindsight-manager/test',
      banks: '/plugins/dsh-hindsight-manager/banks',
      save: '/plugins/dsh-hindsight-manager/save',
    };

    // -- i18n -----------------------------------------------------------------

    const zh = {
      title: 'Hindsight 记忆',
      intro:
        '管理官方 Hindsight 插件的服务地址与工作区记忆库（bank）。请先从 DSH 插件市场安装并启用 @vectorize-io/hindsight-coding-agents。',
      connection: '连接',
      apiUrl: '服务地址',
      apiUrlHint: '填 REST 根，例如 http://host:8888。不要带 /mcp 后缀 —— 那会让所有请求静默返回空对象。',
      test: '测试连接',
      testing: '测试中…',
      banks: '工作区映射',
      banksHint: '路径前缀匹配，最长优先。官方插件根据这些配置选择记忆库。',
      dir: '工作区目录',
      bank: '记忆库',
      status: '状态',
      add: '添加映射',
      remove: '移除',
      save: '保存',
      saved: '已保存，请重启 DSH 使配置生效',
      saving: '保存中…',
      reload: '重新读取',
      exists: '目录存在',
      missing: '目录不存在',
      unchecked: '保存后检查目录',
      notMapped: '未映射',
      options: '选项',
      optInOnly: '仅限已授权工作区',
      optInOnlyHint: '开启后，仅映射目录和配置文件 optInPaths 中的目录启用记忆。关闭则由官方插件为其他工作区解析记忆库。',
      retainSessions: '会话回写',
      restNote: '保存后请重启 DSH，让官方插件读取新配置。测试连接与刷新库列表使用已保存的配置。',
      loading: '读取中…',
      errorLoading: '读取配置失败',
      enterPath: '输入工作区绝对路径',
      bankPlaceholder: 'bank 名',
      unknownBanks: '无法枚举服务器上的库',
      refreshBanks: '刷新库列表',
    };

    const en = {
      title: 'Hindsight memory',
      intro:
        'Manage the official Hindsight plugin’s server and workspace banks. Install and enable @vectorize-io/hindsight-coding-agents from the DSH plugin marketplace first.',
      connection: 'Connection',
      apiUrl: 'Server URL',
      apiUrlHint: 'REST root such as http://host:8888. Do not append /mcp — that makes every request silently return an empty object.',
      test: 'Test connection',
      testing: 'Testing…',
      banks: 'Workspace mappings',
      banksHint: 'Path prefixes, longest wins. The official plugin uses these settings to select memory banks.',
      dir: 'Workspace directory',
      bank: 'Bank',
      status: 'Status',
      add: 'Add mapping',
      remove: 'Remove',
      save: 'Save',
      saved: 'Saved. Restart DSH to apply the settings.',
      saving: 'Saving…',
      reload: 'Reload',
      exists: 'directory exists',
      missing: 'directory missing',
      unchecked: 'save to check directory',
      notMapped: 'unmapped',
      options: 'Options',
      optInOnly: 'Approved workspaces only',
      optInOnlyHint: 'On: enable memory for mappings and optInPaths in the config file. Off: the official plugin resolves banks for other workspaces too.',
      retainSessions: 'Session write-back',
      restNote: 'Restart DSH after saving so the official plugin reads the settings. Connection testing and the bank list use saved settings.',
      loading: 'Loading…',
      errorLoading: 'Failed to read configuration',
      enterPath: 'Absolute workspace path',
      bankPlaceholder: 'bank name',
      unknownBanks: 'Could not enumerate banks on the server',
      refreshBanks: 'Refresh banks',
    };

    // -- styles ---------------------------------------------------------------

    const STYLE = `
.hm-root { display:flex; flex-direction:column; gap:18px; }
.hm-card { border:1px solid var(--dsh-border, #e3e3e3); border-radius:10px; padding:14px 16px; }
.hm-h { font-weight:600; margin:0 0 4px; font-size:14px; }
.hm-sub { color:var(--dsh-text-secondary, #6b6b6b); font-size:12px; line-height:1.5; margin:0 0 10px; }
.hm-row { display:flex; gap:8px; align-items:center; }
.hm-input { flex:1; min-width:0; padding:6px 9px; border:1px solid var(--dsh-border, #d0d0d0); border-radius:6px; background:var(--dsh-bg, #fff); color:inherit; font:inherit; font-size:13px; }
.hm-input:focus { outline:2px solid var(--dsh-accent, #4a7dff); outline-offset:-1px; }
.hm-btn { padding:6px 12px; border-radius:6px; border:1px solid var(--dsh-border, #d0d0d0); background:var(--dsh-bg-elevated, #f7f7f7); color:inherit; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.hm-btn:hover:not(:disabled) { background:var(--dsh-bg-hover, #eee); }
.hm-btn:disabled { opacity:.5; cursor:default; }
.hm-btn-primary { background:var(--dsh-accent, #4a7dff); border-color:var(--dsh-accent, #4a7dff); color:#fff; }
.hm-btn-primary:hover:not(:disabled) { filter:brightness(1.07); }
.hm-btn-danger { color:#c0392b; }
.hm-list { display:flex; flex-direction:column; gap:8px; }
.hm-item { display:grid; grid-template-columns:1fr 180px auto auto; gap:8px; align-items:center; }
.hm-mono { font-family:var(--dsh-font-mono, ui-monospace, monospace); font-size:12px; }
.hm-badge { font-size:11px; padding:2px 7px; border-radius:999px; white-space:nowrap; }
.hm-ok { background:rgba(39,174,96,.14); color:#1e8449; }
.hm-bad { background:rgba(192,57,43,.14); color:#a93226; }
.hm-muted { background:rgba(127,127,127,.14); color:inherit; opacity:.8; }
.hm-note { font-size:12px; line-height:1.55; padding:9px 11px; border-radius:7px; }
.hm-note-ok { background:rgba(39,174,96,.12); }
.hm-note-bad { background:rgba(192,57,43,.12); }
.hm-check { display:flex; gap:7px; align-items:flex-start; font-size:13px; }
.hm-check input { margin-top:2px; }
.hm-empty { color:var(--dsh-text-secondary, #6b6b6b); font-size:12px; padding:6px 0; }
@media (max-width:720px){ .hm-item { grid-template-columns:1fr; } }
`;

    // -- page -----------------------------------------------------------------

    const EMPTY_LIST = Object.freeze([]);
    const selectWorkspaceItems = (snapshot) =>
      snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.items) ? snapshot.items : EMPTY_LIST;

    function Page(props) {
      const t = props.t ?? ((key) => zh[key] ?? key);
      // 宿主在 settings.section 上注入的标准 prop：已登记的工作区，作为快速选择
      const workspaceItems =
        typeof props.useWorkspaces === 'function' ? props.useWorkspaces(selectWorkspaceItems) : EMPTY_LIST;
      const [state, setState] = useState(undefined);
      const [error, setError] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(undefined);
      const [probe, setProbe] = useState(undefined);
      const [bankList, setBankList] = useState(undefined);
      const [draft, setDraft] = useState(undefined);

      const load = useCallback(async () => {
        setError(undefined);
        try {
          const response = await fetch(ROUTES.state, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          setState(body);
          setDraft({
            apiUrl: body.apiUrl,
            positions: body.positions.map((row) => ({ dir: row.dir, bank: row.bank })),
            optInOnly: body.optInOnly,
            retainSessions: body.retainSessions,
          });
        } catch (loadError) {
          setError(String(loadError?.message ?? loadError));
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      useEffect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = NS;
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, []);

      const runProbe = async () => {
        setProbe(undefined);
        try {
          const response = await fetch(ROUTES.test, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          setProbe(await response.json());
        } catch (probeError) {
          setProbe({ ok: false, error: String(probeError?.message ?? probeError) });
        }
      };

      const loadBanks = async () => {
        try {
          const response = await fetch(ROUTES.banks, { credentials: 'same-origin' });
          const body = await response.json();
          setBankList(body);
        } catch (banksError) {
          setBankList({ ok: false, error: String(banksError?.message ?? banksError), banks: [] });
        }
      };

      const save = async () => {
        setBusy(true);
        setNotice(undefined);
        try {
          const response = await fetch(ROUTES.save, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              apiUrl: draft.apiUrl,
              positions: draft.positions,
              optInOnly: draft.optInOnly,
              retainSessions: draft.retainSessions,
            }),
          });
          const body = await response.json();
          if (!response.ok || body.ok === false) {
            setNotice({ ok: false, text: body.error ?? `HTTP ${response.status}` });
          } else {
            setNotice({ ok: true, text: t('saved') });
            setState(body.settings);
          }
        } catch (saveError) {
          setNotice({ ok: false, text: String(saveError?.message ?? saveError) });
        } finally {
          setBusy(false);
        }
      };

      const patchRow = (index, key, value) => {
        setDraft((current) => {
          const positions = current.positions.map((row, position) =>
            position === index ? { ...row, [key]: value } : row
          );
          return { ...current, positions };
        });
      };

      const addRow = (dir, bank) => {
        setDraft((current) => ({ ...current, positions: [...current.positions, { dir: dir ?? '', bank: bank ?? '' }] }));
      };

      const removeRow = (index) => {
        setDraft((current) => ({ ...current, positions: current.positions.filter((_, position) => position !== index) }));
      };

      if (error !== undefined) {
        return h('div', { className: 'hm-root' }, h('div', { className: 'hm-note hm-note-bad' }, `${t('errorLoading')}: ${error}`));
      }
      if (state === undefined || draft === undefined) {
        return h('div', { className: 'hm-root' }, h('div', { className: 'hm-empty' }, t('loading')));
      }

      const knownBanks = bankList?.banks ?? [];
      const datalistId = 'hm-bank-list';

      return h(
        'div',
        { className: 'hm-root' },
        h('p', { className: 'hm-sub', style: { margin: 0 } }, t('intro')),

        // 连接
        h(
          'div',
          { className: 'hm-card' },
          h('p', { className: 'hm-h' }, t('connection')),
          h('p', { className: 'hm-sub' }, t('apiUrlHint')),
          h(
            'div',
            { className: 'hm-row' },
            h('input', {
              className: 'hm-input hm-mono',
              value: draft.apiUrl,
              placeholder: 'http://127.0.0.1:8888',
              onChange: (event) => setDraft({ ...draft, apiUrl: event.target.value }),
            }),
            h('button', { className: 'hm-btn', onClick: runProbe, disabled: busy }, t('test')),
          ),
          probe !== undefined
            ? h(
                'div',
                { className: `hm-note ${probe.ok ? 'hm-note-ok' : 'hm-note-bad'}`, style: { marginTop: 10 } },
                probe.ok
                  ? `OK · bank=${probe.bank}${probe.documents === undefined ? '' : ` · documents=${probe.documents}`}`
                  : `失败：${probe.error ?? 'unknown'}`
              )
            : null,
          h('div', { className: 'hm-sub hm-mono', style: { marginTop: 10, marginBottom: 0 } }, state.configPath),
        ),

        // 工作区映射
        h(
          'div',
          { className: 'hm-card' },
          h(
            'div',
            { className: 'hm-row', style: { justifyContent: 'space-between', marginBottom: 4 } },
            h('p', { className: 'hm-h', style: { margin: 0 } }, t('banks')),
            h(
              'div',
              { className: 'hm-row' },
              h('button', { className: 'hm-btn', onClick: loadBanks }, t('refreshBanks')),
              h('button', { className: 'hm-btn', onClick: () => addRow() }, t('add')),
            ),
          ),
          h('p', { className: 'hm-sub' }, t('banksHint')),

          // 已登记工作区的快捷入口：一键加入映射
          workspaceItems.length > 0
            ? h(
                'div',
                { className: 'hm-row', style: { flexWrap: 'wrap', marginBottom: 10 } },
                workspaceItems
                  .map((item) => item?.path ?? item?.dir ?? item?.cwd)
                  .filter((dir) => typeof dir === 'string' && dir.length)
                  .filter((dir) => !draft.positions.some((row) => row.dir === dir))
                  .map((dir) =>
                    h(
                      'button',
                      {
                        key: dir,
                        className: 'hm-btn hm-mono',
                        title: dir,
                        style: { fontSize: 11, padding: '4px 9px' },
                        onClick: () => addRow(dir, ''),
                      },
                      `+ ${dir.split('/').filter(Boolean).pop() ?? dir}`,
                    )
                  ),
              )
            : null,

          h(
            'datalist',
            { id: datalistId },
            knownBanks.map((bank) => h('option', { key: bank, value: bank })),
          ),

          draft.positions.length === 0
            ? h('div', { className: 'hm-empty' }, t('notMapped'))
            : h(
                'div',
                { className: 'hm-list' },
                draft.positions.map((row, index) =>
                  h(
                    'div',
                    { className: 'hm-item', key: `${row.dir}-${index}` },
                    h('input', {
                      className: 'hm-input hm-mono',
                      value: row.dir,
                      placeholder: t('enterPath'),
                      onChange: (event) => patchRow(index, 'dir', event.target.value),
                    }),
                    h('input', {
                      className: 'hm-input hm-mono',
                      value: row.bank,
                      placeholder: t('bankPlaceholder'),
                      list: datalistId,
                      onChange: (event) => patchRow(index, 'bank', event.target.value),
                    }),
                    h(
                      'span',
                      {
                        className: 'hm-badge hm-muted',
                        title: row.dir,
                      },
                      state.positions.find((entry) => entry.dir === row.dir)?.exists === true
                        ? t('exists')
                        : state.positions.find((entry) => entry.dir === row.dir)?.exists === false
                          ? t('missing')
                          : t('unchecked'),
                    ),
                    h(
                      'button',
                      { className: 'hm-btn hm-btn-danger', onClick: () => removeRow(index) },
                      t('remove'),
                    ),
                  )
                )
              ),

          bankList !== undefined && !bankList.ok
            ? h('div', { className: 'hm-sub', style: { marginTop: 8, marginBottom: 0 } }, `${t('unknownBanks')}: ${bankList.error}`)
            : null,
        ),

        // 选项
        h(
          'div',
          { className: 'hm-card' },
          h('p', { className: 'hm-h' }, t('options')),
          h(
            'label',
            { className: 'hm-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.optInOnly,
              onChange: (event) => setDraft({ ...draft, optInOnly: event.target.checked }),
            }),
            h('span', null, h('strong', null, t('optInOnly')), h('br'), h('span', { className: 'hm-sub' }, t('optInOnlyHint'))),
          ),
          h(
            'label',
            { className: 'hm-check', style: { marginTop: 10 } },
            h('input', {
              type: 'checkbox',
              checked: draft.retainSessions,
              onChange: (event) => setDraft({ ...draft, retainSessions: event.target.checked }),
            }),
            h('span', null, t('retainSessions')),
          ),
        ),

        // 操作
        h(
          'div',
          { className: 'hm-row' },
          h('button', { className: 'hm-btn hm-btn-primary', onClick: save, disabled: busy }, busy ? t('saving') : t('save')),
          h('button', { className: 'hm-btn', onClick: load, disabled: busy }, t('reload')),
          notice !== undefined
            ? h('span', { className: `hm-badge ${notice.ok ? 'hm-ok' : 'hm-bad'}` }, notice.text)
            : null,
        ),
        h('p', { className: 'hm-sub', style: { margin: 0 } }, t('restNote')),
      );
    }

    // -- plugin entry ---------------------------------------------------------

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hindsight-manager: dictionaries');
      } catch {
        /* locale 不可用就退回内置中文 */
      }
      const t = (() => {
        try {
          return ctx.locale.bind(NS);
        } catch {
          return (key) => zh[key] ?? key;
        }
      })();

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 17,
            label: () => t('title'),
            locale: NS,
            inject: () => ({ t }),
          },
          Page,
        ),
      );
    }

    exports.name = NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.Page = Page;
    return module.exports;
  },
});
