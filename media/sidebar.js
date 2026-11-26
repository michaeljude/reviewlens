(function () {
  const vscode = acquireVsCodeApi();
  const { el, ago, plural, RISK, rerender, textarea } = window.acr;
  const root = document.getElementById('root');
  const saved = vscode.getState() || {};
  let groupBy = saved.groupBy || 'area';
  let state = null;
  let selected = saved.selected || null;
  // Unsent review text per pull/merge request, and whether to add the file-by-file summary.
  const drafts = saved.drafts || {};
  let addSummary = saved.addSummary !== false;
  let submitting = false;

  const CATEGORY_ORDER = ['ui', 'logic', 'api', 'types', 'database', 'test', 'infra', 'ci', 'automation', 'config', 'docs', 'other'];
  const CATEGORY_LABELS = {
    ui: 'UI', logic: 'Business logic', api: 'API & networking', types: 'Shared types', database: 'Database',
    test: 'Unit tests', infra: 'Infra', ci: 'CI/CD', automation: 'Automation', config: 'Config & dependencies',
    docs: 'Docs', other: 'Other',
  };
  const BEHAVIOUR = new Set(['ui', 'logic', 'api', 'types', 'database']);

  function post(msg) { vscode.postMessage(msg); }
  function persist() { vscode.setState({ groupBy, selected, drafts, addSummary }); }

  function fileRow(f) {
    const open = () => {
      selected = f.path;
      persist();
      post({ type: 'open', path: f.path });
      render();
    };
    const riskClass = f.risk || 'none';
    return el('div', { class: 'row' + (selected === f.path ? ' selected' : '') },
      el('input', {
        type: 'checkbox',
        checked: f.decision === 'approved',
        title: 'Approve ' + f.name,
        'aria-label': 'Approve ' + f.path,
        onchange: () => post({ type: 'decide', path: f.path, decision: 'approved' }),
      }),
      el('button', { class: 'open', title: f.path, onclick: open },
        el('span', { class: 'status ' + (f.status === '?' ? 'untracked' : f.status), title: f.statusWord }, f.status === '?' ? 'U' : f.status),
        el('span', { class: 'names' },
          el('span', null, f.name),
          el('span', { class: 'muted small' }, (groupBy === 'area' ? f.categoryLabel : f.area) + (f.dir ? ' · ' + f.dir : '')),
        ),
        f.decision === 'changes' ? el('span', { class: 'tag changes' }, 'CHANGES') : null,
        f.needsAi ? el('span', { class: 'tag stale', title: 'Not reviewed by AI in its current version (or its rules changed)' }, 'NEW') : null,
        f.findings ? el('span', { class: 'tag rule', title: plural(f.findings, 'rule finding') }, '⚑ ' + f.findings) : null,
        f.comments ? el('span', { class: 'tag comments' + (f.openThreads ? ' open' : ''), title: plural(f.comments, 'comment') + (f.openThreads ? ', ' + plural(f.openThreads, 'open thread') : '') }, '💬 ' + f.comments) : null,
        el('span', { class: 'dot ' + riskClass, title: f.risk ? RISK[f.risk] : f.skipAi ? 'Not sent to AI' : 'No AI review yet' }),
        el('span', { class: 'counts' },
          f.binary ? el('span', { class: 'muted' }, 'bin') : [el('span', { class: 'add' }, '+' + f.added), ' ', el('span', { class: 'del' }, '−' + f.deleted)],
        ),
      ),
    );
  }

  function groups(files) {
    if (groupBy === 'area') {
      const byArea = new Map();
      for (const f of files) {
        if (!byArea.has(f.area)) byArea.set(f.area, []);
        byArea.get(f.area).push(f);
      }
      return { list: [...byArea.entries()].sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || a[0].localeCompare(b[0])).map(([label, fs]) => ({ label, files: fs })), untouched: [], warn: null };
    }
    const byCat = new Map();
    const uncategorised = [];
    for (const f of files) {
      if (!f.category) { uncategorised.push(f); continue; }
      if (!byCat.has(f.category)) byCat.set(f.category, []);
      byCat.get(f.category).push(f);
    }
    const list = CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({ label: CATEGORY_LABELS[c], files: byCat.get(c) }));
    if (uncategorised.length) list.push({ label: 'Not categorised yet', files: uncategorised });
    const untouched = ['test', 'infra', 'ci', 'automation'].filter((c) => !byCat.has(c)).map((c) => CATEGORY_LABELS[c]);
    const behaviourChanged = files.some((f) => BEHAVIOUR.has(f.category));
    const warn = behaviourChanged && !byCat.has('test')
      ? 'No test files changed, but code that changes behaviour did.'
      : null;
    return { list, untouched, warn };
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function tabs() {
    const p = state.pr;
    const prLabel = cap(p.noun) + 's';
    return el('div', { class: 'seg', role: 'tablist', 'aria-label': 'What to review' },
      el('button', { role: 'tab', 'aria-pressed': String(state.mode === 'local'), 'aria-selected': String(state.mode === 'local'), onclick: () => post({ type: 'mode', mode: 'local' }) },
        'Local changes', state.localCount ? ' (' + state.localCount + ')' : ''),
      el('button', { role: 'tab', 'aria-pressed': String(state.mode === 'pr'), 'aria-selected': String(state.mode === 'pr'), onclick: () => post({ type: 'mode', mode: 'pr' }) },
        prLabel),
    );
  }

  function render() {
    rerender(root, build);
  }

  function build() {
    if (!state) return;
    const side = el('div', { class: 'side' });
    root.append(side);
    side.append(tabs());
    if (state.mode === 'pr') {
      renderPr(side);
      return;
    }
    if (state.message) {
      side.append(el('p', { class: 'muted' }, state.message));
      if (!state.files.length) {
        side.append(el('button', { class: 'btn secondary', onclick: () => post({ type: 'refresh' }) }, 'Refresh'));
        return;
      }
    }
    renderReview(side, state.files);
  }

  function prRow(p) {
    return el('div', { class: 'row' },
      el('button', { class: 'open', title: p.title, onclick: () => post({ type: 'selectPr', number: p.number }) },
        el('span', { class: 'names' },
          el('span', null, el('span', { class: 'muted mono' }, '#' + p.number + ' '), p.title),
          el('span', { class: 'muted small' }, p.author + ' · ' + p.sourceBranch + ' → ' + p.targetBranch + ' · ' + ago(Date.parse(p.updatedAt))),
        ),
        p.draft ? el('span', { class: 'tag stale' }, 'DRAFT') : null,
        p.unread ? el('span', { class: 'tag unread', title: plural(p.unread, 'new update') + ' since you last opened it' }, '● ' + p.unread + ' new') : null,
      ),
    );
  }

  const REVIEWER = {
    approved: { icon: '✓', text: 'approved', cls: 'low' },
    changes: { icon: '✎', text: 'requested changes', cls: 'high' },
    commented: { icon: '💬', text: 'commented', cls: 'info' },
    pending: { icon: '○', text: 'waiting', cls: 'muted' },
  };

  function reviewersEl(list) {
    if (!list.length) return el('div', { class: 'muted small' }, 'No reviewers yet.');
    return el('div', { class: 'reviewers' }, list.map((r) => {
      const k = REVIEWER[r.state] || REVIEWER.pending;
      return el('span', { class: 'reviewer ' + k.cls, title: r.user + ' ' + k.text }, k.icon + ' ' + r.user);
    }));
  }

  function reviewCard(p) {
    const s = p.selected;
    const key = 'review:' + s.number;
    const noun = p.noun;
    if (s.state !== 'open') {
      return el('div', { class: 'card muted small' }, 'This ' + noun + ' is ' + s.state + ', so reviews can’t be posted any more.');
    }
    const busy = p.posting || submitting;
    const submit = (event) => {
      submitting = true;
      render();
      post({ type: 'submitReview', event, body: drafts[key] || '', summary: addSummary });
    };
    const btn = (event, label, primary, extra) => el('button', Object.assign({
      class: 'btn' + (primary ? '' : ' secondary'),
      disabled: busy,
      onclick: () => submit(event),
    }, extra || {}), label);
    const sug = s.suggestedEvent;
    return el('div', { class: 'card review-card' },
      el('div', { class: 'section-title' }, 'Your review on ' + p.hostLabel),
      textarea(drafts, key, { class: 'input', placeholder: 'Overall comment (optional when approving)', 'aria-label': 'Overall review comment' }, persist),
      s.summaryPreview
        ? el('label', { class: 'small check' },
            el('input', { type: 'checkbox', checked: addSummary, onchange: (e) => { addSummary = e.target.checked; persist(); } }),
            ' Add the file-by-file summary',
            el('span', { class: 'muted' }, ' (' + s.summaryPreview.split('\n')[0].replace(/^File-by-file review: /, '').replace(/\.$/, '') + ')'))
        : null,
      el('div', { class: 'review-buttons' },
        s.canApprove
          ? btn('approve', busy ? 'Posting…' : 'Approve', sug === 'approve')
          : el('button', { class: 'btn secondary', disabled: true, title: s.approveBlockedReason }, 'Approve'),
        btn('changes', 'Request changes', sug === 'changes'),
        btn('comment', 'Comment', sug === 'comment'),
      ),
      el('div', { class: 'muted small' },
        'Posts to ' + p.hostLabel + (p.me ? ' as @' + p.me : '') + ' after you confirm. ' +
        (s.canApprove ? '' : (s.approveBlockedReason || '') + ' ') +
        (sug === 'changes' ? 'Suggested: request changes, because files are marked “Request changes”.' : sug === 'approve' ? 'Suggested: approve, because every file is approved.' : '')),
    );
  }

  function renderPr(side) {
    const p = state.pr;
    const nounPlural = p.noun + 's';
    if (!p.available) {
      side.append(el('p', { class: 'muted' }, p.listMessage || "This repository's remote isn't on GitHub or GitLab, so there are no " + nounPlural + ' to show.'));
      return;
    }
    if (!p.signedIn && !p.listLoading) {
      const gitlab = p.hostLabel === 'GitLab';
      side.append(el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:8px' },
        el('div', null, 'Sign in to ' + p.hostLabel + ' to see ' + nounPlural + ' for ', el('span', { class: 'mono' }, p.repo || 'this repository'), '.'),
        p.listMessage ? el('div', { class: 'warn' }, p.listMessage) : null,
        el('button', { class: 'btn block', onclick: () => post({ type: gitlab ? 'useToken' : 'signIn' }) }, gitlab ? 'Add a GitLab access token' : 'Sign in to GitHub'),
        gitlab ? null : el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); post({ type: 'useToken' }); } }, 'Use a personal access token instead'),
        el('div', { class: 'muted small' }, gitlab
          ? 'Use the api scope to post comments and approvals (read_api only lets you read). Kept in the editor’s secure storage.'
          : 'To post comments and reviews, a token needs Pull requests read and write. Kept in the editor’s secure storage.'),
      ));
      return;
    }
    if (p.selected) {
      const s = p.selected;
      side.append(el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); post({ type: 'back' }); } }, '← All ' + nounPlural));
      side.append(el('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px' },
        el('div', { style: 'font-weight:600' }, el('span', { class: 'muted mono' }, '#' + s.number + ' '), s.title,
          s.draft ? ' ' : null, s.draft ? el('span', { class: 'tag stale' }, 'DRAFT') : null,
          s.state !== 'open' ? ' ' : null, s.state !== 'open' ? el('span', { class: 'tag changes' }, s.state.toUpperCase()) : null),
        el('div', { class: 'muted small' }, s.author + ' · ', el('span', { class: 'mono' }, s.sourceBranch + ' → ' + s.targetBranch)),
        s.description ? el('div', { class: 'small', style: 'white-space:pre-wrap;max-height:84px;overflow:hidden' }, s.description) : el('div', { class: 'muted small' }, 'No description.'),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          el('button', { class: 'btn secondary', onclick: () => post({ type: 'openPrWeb' }) }, 'Open on ' + p.hostLabel),
          el('button', { class: 'btn secondary', disabled: p.refreshing, title: 'Get the latest comments, reviews and commits', onclick: () => post({ type: 'refresh' }) }, p.refreshing ? 'Refreshing…' : 'Refresh'),
          s.commentCount ? el('span', { class: 'muted small', style: 'align-self:center' }, plural(s.commentCount, 'comment') + (s.openThreads ? ' · ' + s.openThreads + ' open' : '')) : null,
        ),
        el('div', { class: 'section-title', style: 'margin:4px 0 0' }, 'Reviewers'),
        reviewersEl(s.reviewers),
        s.notice ? el('div', { class: 'warn' }, s.notice) : null,
      ));
      if (p.loading) {
        side.append(el('p', { class: 'muted' }, 'Loading changed files…'));
        return;
      }
      if (p.message && !state.files.length) {
        side.append(el('p', { class: 'muted' }, p.message));
        return;
      }
      renderReview(side, state.files);
      side.append(reviewCard(p));
      return;
    }
    side.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:6px' },
      el('span', { class: 'muted small mono' }, p.repo || ''),
      el('button', { class: 'btn secondary', disabled: p.listLoading || p.refreshing, onclick: () => post({ type: 'refresh' }) }, p.listLoading || p.refreshing ? 'Refreshing…' : 'Refresh'),
    ));
    side.append(el('div', { class: 'muted small' },
      p.notifications
        ? 'Refresh also tells you about new review requests, and new comments and reviews on your ' + nounPlural + '.'
        : ['Notifications are off. ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'settings' }); } }, 'Settings')]));
    if (p.listMessage) side.append(el('div', { class: p.list ? 'muted' : 'warn' }, p.listMessage));
    const list = p.list || [];
    const sections = [
      ['Waiting for your review', list.filter((x) => x.reviewRequested)],
      ['Yours', list.filter((x) => x.mine && !x.reviewRequested)],
      ['Other open ' + nounPlural, list.filter((x) => !x.mine && !x.reviewRequested)],
    ];
    for (const [label, items] of sections) {
      if (!items.length) continue;
      side.append(el('div', null,
        el('div', { class: 'group-head' }, label, el('span', { class: 'count' }, String(items.length))),
        items.map(prRow),
      ));
    }
  }

  // Which review rules and skills the AI follows, with a link to manage them.
  function rulesLine(files) {
    const r = state.rules;
    const found = files.reduce((n, f) => n + (f.findings || 0), 0);
    const link = (text) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'rules' }); } }, text);
    let text;
    if (!r.count) text = 'No review rules yet. ';
    else if (!r.enabled) text = 'Review rules are off (' + r.label + '). ';
    else text = 'Following ' + r.label + (found ? ' · ' + plural(found, 'finding') : '') + '. ';
    return el('div', { class: 'muted small rules-line' },
      el('span', { class: 'rule-mark' }, '⚑'), ' ', text, link(r.count ? 'Manage' : 'Add rules'),
      r.problems.length ? el('div', { class: 'warn small' }, r.problems[0] + (r.problems.length > 1 ? ' (+' + (r.problems.length - 1) + ' more)' : '')) : null,
    );
  }

  function renderReview(side, files) {
    const added = files.reduce((n, f) => n + f.added, 0);
    const deleted = files.reduce((n, f) => n + f.deleted, 0);
    const risks = { high: 0, medium: 0, low: 0 };
    files.forEach((f) => { if (f.risk) risks[f.risk]++; });
    const approved = files.filter((f) => f.decision === 'approved').length;
    const changes = files.filter((f) => f.decision === 'changes').length;

    const n = state.needsAiCount;
    const statusText = state.running
      ? 'Running AI review…'
      : n > 0
        ? plural(n, 'file') + ' not reviewed by AI yet'
        : 'AI review up to date';
    const dotClass = state.running ? 'info' : n > 0 ? 'medium' : 'low';
    const runLabel = state.running ? 'Reviewing…' : n > 0 ? 'Run AI on ' + plural(n, 'file') : 'Run AI review';

    side.append(el('div', { class: 'card' },
      el('div', { class: 'stats' },
        el('span', null, plural(files.length, 'file')),
        el('span', { class: 'add mono' }, '+' + added),
        el('span', { class: 'del mono' }, '−' + deleted),
        risks.high ? el('span', null, el('span', { class: 'dot high' }), ' ', risks.high + ' high') : null,
        risks.medium ? el('span', null, el('span', { class: 'dot medium' }), ' ', risks.medium + ' medium') : null,
        risks.low ? el('span', null, el('span', { class: 'dot low' }), ' ', risks.low + ' low') : null,
      ),
      state.summary ? el('p', { class: 'summary-text' }, state.summary, ' ', el('span', { class: 'muted small' }, '(' + ago(state.summaryAt) + ')')) : null,
      el('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:6px' },
        el('div', { class: 'ai-status' }, el('span', { class: 'dot ' + dotClass }), statusText),
        el('button', { class: 'btn block' + (n > 0 && !state.running ? '' : ' secondary'), disabled: state.running, onclick: () => post({ type: 'run' }) }, runLabel),
        el('div', { class: 'muted small', style: 'display:flex;justify-content:space-between;gap:6px' },
          el('span', null, n > 0 ? 'Reviewed files reuse saved results.' : 'Nothing new to send.'),
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); post({ type: 'settings' }); } }, state.backendLabel),
        ),
        rulesLine(files),
      ),
    ));

    side.append(el('div', { class: 'seg', role: 'group', 'aria-label': 'Group files by' },
      el('button', { 'aria-pressed': String(groupBy === 'area'), onclick: () => { groupBy = 'area'; persist(); render(); } }, 'Area'),
      el('button', { 'aria-pressed': String(groupBy === 'type'), onclick: () => { groupBy = 'type'; persist(); render(); } }, 'Change type'),
    ));

    const g = groups(files);
    for (const group of g.list) {
      side.append(el('div', null,
        el('div', { class: 'group-head' }, group.label, el('span', { class: 'count' }, String(group.files.length))),
        group.files.map(fileRow),
      ));
    }
    if (g.warn) side.append(el('div', { class: 'warn' }, g.warn));
    if (g.untouched.length) side.append(el('div', { class: 'muted small' }, 'No changes in: ' + g.untouched.join(' · ')));

    side.append(el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:4px' },
      el('div', { class: 'small', style: 'display:flex;justify-content:space-between' },
        el('span', { class: 'muted' }, 'Approved'),
        el('span', null, approved + ' of ' + files.length + (changes ? ' · ' + changes + ' need changes' : '')),
      ),
      el('div', { class: 'progress' }, el('div', { style: 'width:' + (files.length ? Math.round((approved / files.length) * 100) : 0) + '%' })),
      el('button', { class: 'btn secondary block', onclick: () => post({ type: 'approveLowRisk' }) }, 'Approve remaining low-risk files'),
    ));
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'state') {
      state = msg.state;
      render();
    } else if (msg.type === 'done' && msg.key === 'review') {
      submitting = false;
      if (msg.ok && state && state.pr.selected) {
        delete drafts['review:' + state.pr.selected.number];
        persist();
      }
      render();
    }
  });
  post({ type: 'ready' });
})();
