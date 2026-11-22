/**
 * Browser half of @onlyfeng/dsh-forge-gitlab-project.
 *
 * Adds one right-sidebar tab, "项目开放 MR" / "Project open MRs", that lists the open merge
 * requests of the checkout the on-screen Session works in and tracks a chosen one into that
 * same Session, where the native change-request panel then shows it.
 *
 * Hand-authored browser JavaScript: no build step, no Harness Client package is imported, and
 * React comes from the module table. The logic that decides what the panel shows lives in the
 * exported pure reducers at the top of the factory so it can be tested without React or a DOM.
 */
window.__ModuleLoader__.load({
  id: '@onlyfeng/dsh-forge-gitlab-project',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Tab kind, also the navigation name callers pass to openTab. */
    const KIND = 'gitlab-project-mrs';

    /** Implementation identity: the registry key the type, body, and title register under. */
    const ID = '@onlyfeng/dsh-forge-gitlab-project';

    /** Locale namespace owning every string this panel draws. */
    const NS = 'forgeGitlabProject';

    /** Pages the Host command serves; a page outside this range is never requested. */
    const FIRST_PAGE = 1;
    const LAST_PAGE = 20;

    /** A scope token is 32 lowercase hexadecimal digits; anything else is not a usable scope. */
    const SCOPE = /^[0-9a-f]{32}$/;

    const zh = {
      'type.label': '项目开放 MR',
      'guide.title': '项目开放 MR',
      'guide.description': '浏览本项目的开放合并请求，并将其加入当前会话',
      'state.loading': '正在读取合并请求…',
      'state.noPage': '本页没有开放 MR，可返回上一页。',
      'state.capped': '已显示前 500 条，更多开放 MR 请在 GitLab 中查看。',
      'state.added': '已加入 !{iid}，可在「代码审查和变更」中查看。',
      'state.empty': '该项目没有开放的合并请求。',
      'state.noSession': '请先打开一个会话。',
      'error.noCheckout': '当前会话目录不在 Git 检出中。请打开项目目录，或输入 GitLab 项目地址。',
      'error.changed': '检出或所选 MR 已变化，请刷新项目列表。',
      'error.access': '请核对该 GitLab 实例的 glab 登录状态和项目读取权限。',
      'error.read': '无法读取该 GitLab 项目，请检查连接后刷新列表。',
      'error.denied': '当前会话的权限限制了 Git 检出读取。可保留现有权限，直接输入 GitLab 项目地址。',
      'error.inspection': 'DSH 未能读取本地 Git 检出。「代码审查和变更」可查看具体原因，也可输入 GitLab 项目地址。',
      'error.pending': '正在检查当前 Git 目录，请稍后刷新。',
      'error.missing': '当前会话的工作树已缺失。请恢复工作树或选取现有检出。',
      'error.moved': '会话的工作目录已变化。请刷新项目列表。',
      'error.unknownProject': '当前检出的远端未关联到已配置的 GitLab 实例。请核对远端和允许的主机。',
      'error.mismatch': '项目地址与当前检出的项目不一致，请核对后重新读取。',
      'error.projectUrl': '请输入已配置 GitLab 实例上的 HTTPS 项目地址，只包含主机和项目路径。',
      'label.projectUrl': 'GitLab 项目地址',
      'action.readProject': '按地址读取',
      'action.useCheckout': '使用当前检出',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.track': '加入会话',
      'action.tracking': '正在加入…',
      'action.tracked': '已在会话中',
      'action.prev': '上一页',
      'action.next': '下一页',
      'label.page': '第 {page} 页',
      'label.project': '项目：{project}',
      'label.draft': '草稿',
      'label.branches': '{source} → {target}',
      'label.author': '作者 {author}',
      'error.unavailable': '当前会话无法执行该命令。请确认已启用 GitLab 项目插件。',
      'error.unexpected': '插件返回了无法解析的结果。',
      'error.trackFailed': '加入会话失败：{reason}',
      'error.staleScope': '列表已过期，请刷新后重试。',
    };

    const en = {
      'type.label': 'Project open MRs',
      'guide.title': 'Project open MRs',
      'guide.description': "Browse this project's open merge requests and add one to this session",
      'state.loading': 'Reading merge requests…',
      'state.noPage': 'No open MRs on this page. Return to the previous page.',
      'state.capped': 'Showing the first 500 requests. See GitLab for more.',
      'state.added': 'Added !{iid}. Open Code review and changes to view it.',
      'state.empty': 'This project has no open merge requests.',
      'state.noSession': 'Open a session first.',
      'error.noCheckout': 'This session directory is outside a Git checkout. Open the project directory or enter a GitLab project URL.',
      'error.changed': 'The checkout or selected merge request changed. Refresh the list.',
      'error.access': 'Check glab sign-in for this GitLab instance and permission to read the project.',
      'error.read': 'Could not read this GitLab project. Check connectivity and refresh the list.',
      'error.denied': 'Session permissions prevented Git inspection. Keep the current permissions and enter the GitLab project URL.',
      'error.inspection': 'DSH could not inspect the checkout. See Code review and changes for the reason, or enter a GitLab project URL.',
      'error.pending': 'Git inspection is in progress. Refresh after it finishes.',
      'error.missing': 'The session worktree is missing. Restore it or select an existing checkout.',
      'error.moved': 'The session directory changed. Refresh the project list.',
      'error.unknownProject': 'No configured GitLab provider recognizes the checkout remote. Check the remote and allowed hosts.',
      'error.mismatch': 'The URL points to a different project from the current checkout. Check the project address.',
      'error.projectUrl': 'Enter the HTTPS address of a project on a configured GitLab host, with only its hostname and project path.',
      'label.projectUrl': 'GitLab project URL',
      'action.readProject': 'Read project',
      'action.useCheckout': 'Use current checkout',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.track': 'Add to session',
      'action.tracking': 'Adding…',
      'action.tracked': 'In this session',
      'action.prev': 'Previous',
      'action.next': 'Next',
      'label.page': 'Page {page}',
      'label.project': 'Project: {project}',
      'label.draft': 'Draft',
      'label.branches': '{source} → {target}',
      'label.author': 'by {author}',
      'error.unavailable': 'This session cannot run the command. Check that the GitLab project plugin is enabled.',
      'error.unexpected': 'The plugin returned a result that could not be read.',
      'error.trackFailed': 'Could not add it to the session: {reason}',
      'error.staleScope': 'This list is out of date. Refresh and try again.',
    };

    /**
     * Clamp a requested page into the range the Host serves.
     * @param {unknown} page - requested page, from a control or restored navigation.
     * @returns {number} a page within FIRST_PAGE..LAST_PAGE.
     */
    function clampPage(page) {
      const value = Math.trunc(Number(page));
      if (!Number.isFinite(value) || value < FIRST_PAGE) return FIRST_PAGE;
      return value > LAST_PAGE ? LAST_PAGE : value;
    }

    /**
     * The panel's state before any read of a session.
     * @param {number} [page] - page to open on.
     * @returns {object} the initial state.
     */
    function initialState(page) {
      return {
        status: 'loading',
        page: clampPage(page ?? FIRST_PAGE),
        items: [],
        project: null,
        projectUrl: null,
        hasMore: false,
        scope: null,
        error: null,
        tracking: {},
        epoch: 0,
      };
    }

    /**
     * Read one merge request out of an untrusted Host payload entry.
     * Returns undefined for an entry without a usable identity, so a partly broken page still lists
     * the rows it can draw instead of failing whole.
     * @param {unknown} entry - one element of the payload's items array.
     * @returns {object | undefined} the row, or undefined when it has no usable iid.
     */
    function rowOf(entry) {
      if (typeof entry !== 'object' || entry === null) return undefined;
      const iid = Math.trunc(Number(entry.iid));
      if (!Number.isSafeInteger(iid) || iid <= 0) return undefined;
      const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
      return {
        iid,
        title: text(entry.title) ?? `!${iid}`,
        author: text(entry.author),
        sourceBranch: text(entry.sourceBranch),
        targetBranch: text(entry.targetBranch),
        webUrl: text(entry.webUrl),
        updatedAt: text(entry.updatedAt),
        draft: entry.draft === true,
        tracked: entry.tracked === true,
      };
    }

    /**
     * Interpret the JSON text of a successful list command.
     * @param {string} text - the command's success text.
     * @returns {object} `{ ok: true, value }` with the listing, or `{ ok: false }` when it cannot be read.
     */
    function parseListing(text) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        // An empty success body is an empty project, not a failure.
        return { ok: true, value: { project: null, page: FIRST_PAGE, hasMore: false, scope: null, items: [] } };
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false };
      }
      if (typeof body !== 'object' || body === null || !Array.isArray(body.items)) return { ok: false };
      const items = [];
      for (const entry of body.items) {
        const row = rowOf(entry);
        if (row !== undefined) items.push(row);
      }
      const scope = typeof body.scope === 'string' && SCOPE.test(body.scope) ? body.scope : null;
      return {
        ok: true,
        value: {
          project: typeof body.projectPath === 'string' && body.projectPath.length > 0 ? body.projectPath : null,
          page: clampPage(body.page),
          hasMore: body.hasMore === true,
          truncated: body.truncated === true,
          scope,
          items,
        },
      };
    }

    /**
     * Fold one event into the panel state. Pure: the same state and event always give the same result,
     * and an event belonging to a superseded read is ignored, so a late answer cannot overwrite a newer
     * list or leak one session's rows into another.
     * @param {object} state - current state.
     * @param {object} event - what happened.
     * @returns {object} the next state.
     */
    function reduce(state, event) {
      switch (event.type) {
        case 'load': {
          // A new read supersedes every answer still in flight and drops the previous scope with it.
          return {
            ...state,
            status: 'loading',
            project: null,
            page: clampPage(event.page ?? state.page),
            projectUrl: event.projectUrl === undefined ? state.projectUrl : event.projectUrl,
            error: null,
            scope: null,
            epoch: state.epoch + 1,
          };
        }
        case 'listed': {
          if (event.epoch !== state.epoch) return state;
          return {
            ...state,
            status: 'ready',
            page: event.listing.page,
            items: event.listing.items,
            project: event.listing.project,
            hasMore: event.listing.hasMore,
            truncated: event.listing.truncated,
            scope: event.listing.scope,
            error: null,
            tracking: {},
          };
        }
        case 'failed': {
          if (event.epoch !== state.epoch) return state;
          return {
            ...state,
            status: 'failed',
            hasMore: false,
            items: [],
            scope: null,
            tracking: {},
            error: { kind: event.kind, text: event.text ?? null },
          };
        }
        case 'track': {
          if (event.epoch !== state.epoch) return state;
          return { ...state, tracking: { ...state.tracking, [event.iid]: { status: 'pending', text: null } } };
        }
        case 'tracked': {
          if (event.epoch !== state.epoch) return state;
          return {
            ...state,
            items: state.items.map((item) => (item.iid === event.iid ? { ...item, tracked: true } : item)),
            tracking: { ...state.tracking, [event.iid]: { status: 'done', text: null } },
          };
        }
        case 'trackFailed': {
          if (event.epoch !== state.epoch) return state;
          return {
            ...state,
            tracking: { ...state.tracking, [event.iid]: { status: 'failed', text: event.text ?? null } },
          };
        }
        case 'session': {
          // A different Session must never show the previous Session's rows or reuse its scope.
          return { ...initialState(FIRST_PAGE), epoch: state.epoch + 1 };
        }
        default:
          return state;
      }
    }

    /**
     * Whether a row's track control may be pressed.
     * @param {object} state - current state.
     * @param {object} item - the row.
     * @returns {boolean} whether tracking is possible right now.
     */
    function canTrack(state, item) {
      if (state.status !== 'ready' || state.scope === null) return false;
      if (item.tracked) return false;
      const entry = state.tracking[item.iid];
      return entry === undefined || entry.status === 'failed';
    }

    /**
     * Resolve the localized label and disabled state of a row's track control.
     * @param {object} state - current state.
     * @param {object} item - the row.
     * @param {Function} t - bound translator.
     * @returns {object} `{ label, disabled, failure }`.
     */
    function trackControl(state, item, t) {
      const entry = state.tracking[item.iid];
      if (item.tracked || entry?.status === 'done') return { label: t('action.tracked'), disabled: true, failure: null };
      if (entry?.status === 'pending') return { label: t('action.tracking'), disabled: true, failure: null };
      const failure = entry?.status === 'failed'
        ? t('error.trackFailed', { reason: errorText({ kind: 'refused', text: entry.text }, t) })
        : null;
      return { label: t('action.track'), disabled: !canTrack(state, item), failure };
    }

    /**
     * The message a failed state shows. A Host refusal is shown verbatim, since the provider
     * writes it for the user; the other kinds have localized copy.
     * @param {object} error - the state's error.
     * @param {Function} t - bound translator.
     * @returns {string} the text to draw.
     */
    function errorText(error, t) {
      if (error.kind === 'refused' && typeof error.text === 'string' && error.text.length > 0) {
        const code = /^\[gitlab-project:([a-zA-Z]+)\]/.exec(error.text)?.[1];
        return code && Object.hasOwn(en, `error.${code}`) ? t(`error.${code}`) : error.text;
      }
      if (error.kind === 'unavailable') return t('error.unavailable');
      return t('error.unexpected');
    }

    const css = `
.ofgp-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); font-size: 13px; }
.ofgp-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ofgp-project { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.ofgp-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 0; }
.ofgp-row { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ofgp-row-head { display: flex; align-items: flex-start; gap: 8px; }
.ofgp-title { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-primary);
  text-decoration: none; overflow-wrap: anywhere; }
.ofgp-title:hover { text-decoration: underline; }
.ofgp-iid { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.ofgp-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.ofgp-tag { padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ofgp-row-foot { display: flex; align-items: center; gap: 8px; }
.ofgp-address { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.ofgp-address label { display: flex; flex: 1 1 14em; flex-direction: column; gap: 4px; min-width: 0; }
.ofgp-address input { font: inherit; color: var(--dsw-alias-label-primary); background: transparent;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 5px 8px; min-width: 0; }
.ofgp-failure { color: var(--dsw-alias-state-error-primary); font-size: 12px; overflow-wrap: anywhere; }
.ofgp-notice { padding: 16px 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ofgp-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2); }
.ofgp-page { flex: 1 1 auto; text-align: center; color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; }
.ofgp-button { appearance: none; display: inline-flex; align-items: center; justify-content: center;
  min-height: 24px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px;
  background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary);
  font: inherit; cursor: pointer; }
.ofgp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ofgp-button:disabled { opacity: 0.5; cursor: default; }
.ofgp-button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
`;

    /** Component-local styles: unmounting the body removes them with it. */
    function Styles() {
      return h('style', null, css);
    }

    /**
     * One merge request row.
     * @param {object} props - `{ item, state, t, onTrack }`.
     * @returns {object} the row element.
     */
    function Row({ item, state, t, onTrack }) {
      const control = trackControl(state, item, t);
      const branches = item.sourceBranch !== null && item.targetBranch !== null
        ? t('label.branches', { source: item.sourceBranch, target: item.targetBranch })
        : null;
      return h('li', { className: 'ofgp-row' },
        h('div', { className: 'ofgp-row-head' },
          item.webUrl === null
            ? h('span', { className: 'ofgp-title' }, item.title)
            : h('a', {
              className: 'ofgp-title', href: item.webUrl, target: '_blank', rel: 'noreferrer noopener',
            }, item.title),
          h('span', { className: 'ofgp-iid' }, `!${item.iid}`)),
        h('div', { className: 'ofgp-meta' },
          item.draft ? h('span', { className: 'ofgp-tag' }, t('label.draft')) : null,
          branches === null ? null : h('span', null, branches),
          item.author === null ? null : h('span', null, t('label.author', { author: item.author }))),
        h('div', { className: 'ofgp-row-foot' },
          h('button', {
            type: 'button', className: 'ofgp-button', disabled: control.disabled,
            'aria-label': `${control.label} !${item.iid}`,
            onClick: () => { onTrack(item); },
          }, control.label),
          h('span', { role: 'status' }, state.tracking[item.iid]?.status === 'done' ? t('state.added', { iid: item.iid }) : ''),
          control.failure === null ? null : h('span', { className: 'ofgp-failure', role: 'alert' }, control.failure)));
    }

    /**
     * The panel body. Reads the on-screen Session from the tab seat, so it draws one Session's
     * project and never another's.
     * @param {object} props - the tab seat's props.
     * @returns {object} the body element.
     */
    function ProjectMergeRequests(props) {
      return h(SessionPicker, { ...props, key: props.sessionId ?? '' });
    }

    function SessionPicker(props) {
      const { t, useTabInfo, listMergeRequests, trackMergeRequest } = props;
      const { tab } = useTabInfo();
      // The tab seat is session-scoped, so the Session it draws arrives as an owner prop.
      const sessionId = props.sessionId ?? null;
      const [state, dispatch] = React.useReducer(reduce, undefined, () => initialState(tab.navigation.params?.page));
      const epoch = state.epoch;
      const [address, setAddress] = React.useState('');
      const [invalidAddress, setInvalidAddress] = React.useState(false);

      // One read per (session, page, explicit refresh); its answer is dropped unless it is still current.
      React.useEffect(() => {
        if (sessionId === null) return undefined;
        let live = true;
        const controller = new AbortController();
        const abort = () => { controller.abort(); };
        tab.signal?.addEventListener('abort', abort);
        void (async () => {
          const answer = await listMergeRequests(sessionId, state.page, controller.signal, state.projectUrl);
          if (!live) return;
          if (answer.kind === 'listed') dispatch({ type: 'listed', epoch, listing: answer.listing });
          else dispatch({ type: 'failed', epoch, kind: answer.kind, text: answer.text });
        })();
        return () => {
          live = false;
          tab.signal?.removeEventListener('abort', abort);
          controller.abort();
        };
      }, [sessionId, state.page, epoch, listMergeRequests, tab.signal, state.projectUrl]);


      const refresh = React.useCallback(() => { dispatch({ type: 'load', page: state.page }); }, [state.page]);

      // The sidebar's refresh command acts on the focused page; the toolbar button does the same thing.
      React.useEffect(() => tab.actions.bindCommands({ refresh }), [tab.actions, refresh]);

      const track = React.useCallback(async (item) => {
        const scope = state.scope;
        if (scope === null) {
          dispatch({ type: 'trackFailed', epoch, iid: item.iid, text: t('error.staleScope') });
          return;
        }
        dispatch({ type: 'track', epoch, iid: item.iid });
        const answer = await trackMergeRequest(sessionId, scope, item.iid);
        if (answer.kind === 'tracked') dispatch({ type: 'tracked', epoch, iid: item.iid });
        else dispatch({ type: 'trackFailed', epoch, iid: item.iid, text: answer.text });
      }, [state.scope, epoch, sessionId, trackMergeRequest, t]);

      if (sessionId === null) {
        return h('div', { className: 'ofgp-root' }, h(Styles), h('p', { className: 'ofgp-notice' }, t('state.noSession')));
      }

      const offerAddress = Boolean(state.projectUrl) || /^\[gitlab-project:(?:denied|inspection|noCheckout|projectUrl)\]/.test(state.error?.text ?? '');
      const addressForm = offerAddress && h('form', { className: 'ofgp-notice ofgp-address', onSubmit: event => {
        event.preventDefault();
        const url = address.trim();
        // Keep credentials, query strings and fragments out of the session command.
        if (!validAddress(url)) { setInvalidAddress(true); return; }
        setInvalidAddress(false);
        dispatch({ type: 'load', page: FIRST_PAGE, projectUrl: url });
      } }, h('label', null, t('label.projectUrl'), h('input', { type: 'url', required: true,
        value: address, maxLength: 2048, placeholder: 'https://gitlab.example.org/group/project',
        onChange: event => { setAddress(event.target.value); setInvalidAddress(false); } })),
        h('button', { type: 'submit', className: 'ofgp-button' }, t('action.readProject')),
        state.projectUrl && h('button', { type: 'button', className: 'ofgp-button', onClick: () => {
          setInvalidAddress(false); dispatch({ type: 'load', page: FIRST_PAGE, projectUrl: null });
        } }, t('action.useCheckout')),
        invalidAddress && h('p', { role: 'alert', className: 'ofgp-failure' }, t('error.projectUrl')));
      const body = state.status === 'loading'
        ? h('p', { className: 'ofgp-notice' }, t('state.loading'))
        : state.status === 'failed'
          ? h('div', { className: 'ofgp-notice' },
            h('p', { className: 'ofgp-failure' }, errorText(state.error, t)),
            h('button', { type: 'button', className: 'ofgp-button', onClick: refresh }, t('action.retry')))
          : state.items.length === 0
            ? h('p', { className: 'ofgp-notice' }, state.page === FIRST_PAGE ? t('state.empty') : t('state.noPage'))
            : h('ul', { className: 'ofgp-list' }, state.items.map((item) => h(Row, {
              key: item.iid, item, state, t, onTrack: track,
            })));

      return h('div', { className: 'ofgp-root' },
        h(Styles),
        h('div', { className: 'ofgp-bar' },
          h('span', { className: 'ofgp-project' },
            state.project === null ? '' : t('label.project', { project: state.project })),
          h('button', {
            type: 'button', className: 'ofgp-button', onClick: refresh, disabled: state.status === 'loading',
          }, t('action.refresh'))),
        addressForm, body,
        state.status === 'ready' && state.truncated ? h('div', { className: 'ofgp-notice' }, t('state.capped')) : null,
        h('div', { className: 'ofgp-foot' },
          h('button', {
            type: 'button', className: 'ofgp-button',
            disabled: state.status === 'loading' || state.page <= FIRST_PAGE,
            onClick: () => { dispatch({ type: 'load', page: state.page - 1 }); },
          }, t('action.prev')),
          h('span', { className: 'ofgp-page' }, t('label.page', { page: state.page })),
          h('button', {
            type: 'button', className: 'ofgp-button',
            disabled: state.status === 'loading' || !state.hasMore || state.page >= LAST_PAGE,
            onClick: () => { dispatch({ type: 'load', page: state.page + 1 }); },
          }, t('action.next'))));
    }

    /**
     * Build the two Host calls over the command Remote. Kept in one place so the panel body holds no
     * transport detail: both answer with a settled result instead of throwing, because a thrown
     * component blanks the slot entry.
     * @param {object} ctx - the plugin context carrying the command Remote.
     * @returns {object} `{ listMergeRequests, trackMergeRequest }`.
     */
    function validAddress(url) {
      return typeof url === 'string' && url.length <= 2048 && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9_][a-z0-9_.-]*){2,}\/?$/i.test(url);
    }

    function createTransport(ctx) {
      /**
       * Run one slash command for a Session and return its settled outcome.
       * Two envelopes are unwrapped here: the Remote's own `{ ok, value, error }`, and the
       * command executor's `{ commandId, result }` inside it.
       */
      const run = async (sessionId, line, signal) => {
        let answer;
        try {
          answer = await ctx.remote.commands.execute(sessionId, line, [], signal);
        } catch (error) {
          return { kind: 'refused', text: error instanceof Error ? error.message : String(error) };
        }
        if (typeof answer !== 'object' || answer === null) return { kind: 'unexpected', text: null };
        if (answer.ok !== true) {
          const message = answer.error?.message;
          return { kind: 'refused', text: typeof message === 'string' && message.length > 0 ? message : null };
        }
        // The executor resolves `undefined` when the command name does not resolve at all.
        if (answer.value === undefined || answer.value === null) return { kind: 'unavailable', text: null };
        const result = answer.value.result;
        if (typeof result !== 'object' || result === null) return { kind: 'unexpected', text: null };
        if (result.kind === 'error') return { kind: 'refused', text: typeof result.text === 'string' ? result.text : null };
        if (result.kind !== 'success') return { kind: 'unexpected', text: null };
        return { kind: 'success', text: typeof result.text === 'string' ? result.text : '' };
      };

      return {
        /**
         * List one page of the project's open merge requests.
         * @param {string} sessionId - the on-screen Session.
         * @param {number} page - page within FIRST_PAGE..LAST_PAGE.
         * @param {AbortSignal} signal - cancellation of the read.
         * @returns {Promise<object>} the listing or the failure to draw.
         */
        listMergeRequests: async (sessionId, page, signal, projectUrl) => {
          if (projectUrl && !validAddress(projectUrl)) return { kind: 'refused', text: '[gitlab-project:projectUrl]' };
          const source = projectUrl ? ` project ${projectUrl}` : '';
          const outcome = await run(sessionId, `/gitlab-project list ${clampPage(page)}${source}`, signal);
          if (outcome.kind !== 'success') return outcome;
          const parsed = parseListing(outcome.text);
          return parsed.ok ? { kind: 'listed', listing: parsed.value } : { kind: 'unexpected', text: null };
        },
        /**
         * Track one merge request into the Session, where the native panel shows it.
         * @param {string} sessionId - the on-screen Session.
         * @param {string} scope - the token the current listing returned.
         * @param {number} iid - merge request number.
         * @returns {Promise<object>} the outcome to draw.
         */
        trackMergeRequest: async (sessionId, scope, iid) => {
          const outcome = await run(sessionId, `/gitlab-project track ${scope} ${iid}`, undefined);
          if (outcome.kind !== 'success') return outcome;
          // The Host reports an already-bound request as a success, so the row simply reads as tracked.
          return { kind: 'tracked' };
        },
      };
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.commands'],

      /** Register the locale dictionary, the tab type with its guide entry, and the tab body. */
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        const transport = createTransport(ctx);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'forge-gitlab-project.copy');
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('type.label'),
          guide: [{
            id: 'open-mrs', order: 40, title: () => t('guide.title'), description: () => t('guide.description'),
          }],
        }), 'forge-gitlab-project.type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: ID, locale: NS,
          inject: () => transport,
        }, ProjectMergeRequests)), 'forge-gitlab-project.body');
      },

      /** Pure logic the UI tests drive directly, without React or a DOM. */
      __internals: {
        KIND, ID, NS, FIRST_PAGE, LAST_PAGE,
        clampPage, initialState, rowOf, parseListing, reduce, canTrack, trackControl, errorText,
        createTransport, zh, en,
      },
    };
  },
});
