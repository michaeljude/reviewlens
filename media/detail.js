(function () {
  const vscode = acquireVsCodeApi();
  const { el, ago, RISK, rerender, textarea } = window.acr;
  const root = document.getElementById('root');
  const saved = vscode.getState() || {};
  // Unsent comment text, by box. Kept across re-renders and reloads of the panel.
  const drafts = saved.drafts || {};
  let last = null;
  let composing = null; // "path|old|new" of the line being commented on
  const replying = new Set();
  const expanded = new Set();
  const busy = new Set();
  let focusKey = null;

  function post(msg) { vscode.postMessage(msg); }
  function persist() { vscode.setState({ drafts }); }

  function rowKey(d, r) { return d.path + '|' + (r.o || '') + '|' + (r.n || ''); }

  function send(msg, key) {
    if (busy.has(key)) return;
    if (msg.type !== 'resolve' && !(drafts[key] || '').trim()) {
      const box = root.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (box) box.focus();
      return;
    }
    busy.add(key);
    draw();
    post(Object.assign({ key }, msg));
  }

  function box(key, placeholder, onSubmit) {
    const t = textarea(drafts, key, { placeholder, 'aria-label': placeholder, class: 'input' });
    t.addEventListener('input', persist);
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
    });
    return t;
  }

  function tag(text, cls) { return el('span', { class: 'tag ' + (cls || 'stale') }, text); }

  function lineLabel(t) {
    if (!t.line) return 'File comment';
    return (t.side === 'old' ? 'Removed line ' : 'Line ') + t.line;
  }

  function threadEl(t, d) {
    const collapsed = t.resolved && !expanded.has(t.id);
    const replyKey = 'reply:' + t.id;
    const resolveKey = 'resolve:' + t.id;
    const toggle = t.resolved
      ? el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); if (collapsed) expanded.add(t.id); else expanded.delete(t.id); draw(); } }, collapsed ? 'Show' : 'Hide')
      : null;
    const head = el('div', { class: 'thead small' },
      el('span', { class: 'muted' }, lineLabel(t)),
      t.outdated ? tag('OUTDATED') : null,
      t.resolved ? tag('RESOLVED', 'ok') : t.resolvable ? tag('OPEN', 'open') : null,
      collapsed ? el('span', { class: 'muted' }, '· ' + t.comments[0].author + ': ' + t.comments[0].body.replace(/\s+/g, ' ').slice(0, 80)) : null,
      el('span', { style: 'flex:1' }),
      toggle,
    );
    if (collapsed) return el('div', { class: 'thread resolved' }, head);

    const comments = t.comments.map((c, i) => el('div', { class: 'comment' + (i ? ' reply' : '') },
      el('div', { class: 'small' },
        el('span', { class: 'who' }, c.author), ' ',
        el('span', { class: 'muted' }, ago(Date.parse(c.createdAt))),
        c.url ? el('a', { href: '#', style: 'margin-left:8px', onclick: (e) => { e.preventDefault(); post({ type: 'openUrl', url: c.url }); } }, 'Open on ' + d.hostLabel) : null,
      ),
      el('div', { class: 'body' }, c.body),
    ));

    let actions = null;
    if (d.canComment) {
      if (replying.has(t.id)) {
        const submit = () => send({ type: 'reply', threadId: t.id, body: drafts[replyKey] || '' }, replyKey);
        actions = el('div', { class: 'reply-box' },
          box(replyKey, 'Reply to ' + t.comments[0].author, submit),
          el('div', { class: 'tactions' },
            el('button', { class: 'btn', disabled: busy.has(replyKey), onclick: submit }, busy.has(replyKey) ? 'Posting…' : 'Reply'),
            el('button', { class: 'btn secondary', onclick: () => { replying.delete(t.id); draw(); } }, 'Cancel'),
            t.resolvable && !t.resolved ? el('button', {
              class: 'btn secondary', disabled: busy.has(replyKey) || busy.has(resolveKey),
              title: 'Post the reply, then resolve the thread',
              onclick: () => { if ((drafts[replyKey] || '').trim()) { pendingResolve.add(t.id); submit(); } },
            }, 'Reply and resolve') : null,
            el('span', { class: 'muted small' }, 'Ctrl/⌘+Enter to send'),
          ),
        );
      } else {
        actions = el('div', { class: 'tactions' },
          el('button', { class: 'btn secondary', onclick: () => { replying.add(t.id); focusKey = replyKey; draw(); } }, 'Reply'),
          t.resolvable ? el('button', {
            class: 'btn secondary', disabled: busy.has(resolveKey),
            onclick: () => send({ type: 'resolve', threadId: t.id, resolved: !t.resolved }, resolveKey),
          }, busy.has(resolveKey) ? 'Saving…' : t.resolved ? 'Reopen thread' : 'Resolve thread') : null,
        );
      }
    }
    return el('div', { class: 'thread' + (t.resolved ? ' resolved' : '') }, head, comments, actions);
  }

  // Threads whose reply was sent with "Reply and resolve": resolved once the reply has posted.
  const pendingResolve = new Set();

  function composer(d, r) {
    const key = 'new:' + rowKey(d, r);
    const submit = () => send({ type: 'comment', oldLine: r.o, newLine: r.n, body: drafts[key] || '' }, key);
    return el('div', { class: 'thread composer' },
      el('div', { class: 'small muted' },
        'New comment on ' + (r.n ? 'line ' + r.n : 'removed line ' + r.o) + '. Posts to ' + d.hostLabel + ' right away' + (d.me ? ' as @' + d.me : '') + '.'),
      box(key, 'Leave a comment', submit),
      el('div', { class: 'tactions' },
        el('button', { class: 'btn', disabled: busy.has(key), onclick: submit }, busy.has(key) ? 'Posting…' : 'Comment'),
        el('button', { class: 'btn secondary', onclick: () => { composing = null; draw(); } }, 'Cancel'),
        el('span', { class: 'muted small' }, 'Ctrl/⌘+Enter to send'),
      ),
    );
  }

  function diffView(d) {
    const byRow = new Map();
    for (const t of d.threads) {
      if (t.row < 0) continue;
      if (!byRow.has(t.row)) byRow.set(t.row, []);
      byRow.get(t.row).push(t);
    }
    const out = [];
    d.rows.forEach((r, i) => {
      const cls = r.k === 'add' ? 'a' : r.k === 'del' ? 'd' : r.k === 'ctx' ? '' : 'h';
      const line = r.k === 'add' || r.k === 'del' || r.k === 'ctx';
      const k = rowKey(d, r);
      out.push(el('div', { class: 'dl ' + cls + (composing === k ? ' target' : '') },
        el('span', { class: 'ln' }, line && r.o ? r.o : ''),
        el('span', { class: 'ln' }, line && r.n ? r.n : ''),
        d.canComment && line
          ? el('button', {
              class: 'cbtn', title: 'Comment on this line', 'aria-label': 'Comment on ' + (r.n ? 'line ' + r.n : 'removed line ' + r.o),
              onclick: () => { composing = k; focusKey = 'new:' + k; draw(); },
            }, '+')
          : el('span', { class: 'cbtn-space' }),
        el('span', { class: 'code' }, r.t || ' '),
      ));
      (byRow.get(i) || []).forEach((t) => out.push(threadEl(t, d)));
      if (composing === k) out.push(composer(d, r));
    });
    return el('div', { class: 'diff', 'data-scroll': 'diff' }, out);
  }

  function draw() {
    if (!last) return;
    rerender(root, () => build(last));
    if (focusKey) {
      const n = root.querySelector('[data-key="' + CSS.escape(focusKey) + '"]');
      if (n) n.focus();
      focusKey = null;
    }
  }

  function ruleLink(d, r) {
    return el('a', { href: '#', title: r.source === 'settings' ? 'Personal rule' : r.source, onclick: (e) => { e.preventDefault(); post({ type: 'openRule', source: r.source }); } },
      (r.kind === 'skill' ? 'Skill: ' : '') + r.title);
  }

  // The developer's rules and skills for this file, and what the AI found against them.
  function rulesCard(d, a) {
    const head = el('div', { style: 'display:flex;align-items:center;gap:8px' },
      el('h2', { class: 'section-title', style: 'flex:1;margin:0' }, 'Review rules'),
      el('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); post({ type: 'rules' }); } }, 'Manage rules'));
    if (!a) {
      if (!d.rules.length) return null;
      return el('div', { class: 'card' }, head,
        el('div', { class: 'small' }, 'The AI will check this file against: ', d.rules.map((r, i) => [i ? ', ' : '', ruleLink(d, r)]), '.'));
    }
    const checked = a.checkedRules || [];
    if (!checked.length && !a.findings) return null;
    let body;
    if (a.findings && a.findings.length) {
      body = a.findings.map((f) => el('div', { class: 'impact' },
        el('span', { class: 'pill ' + f.level }, f.level[0].toUpperCase() + f.level.slice(1)),
        el('div', null,
          el('div', { class: 'kind' }, f.rule, f.line ? el('span', { class: 'muted' }, ' · line ' + f.line) : null),
          el('div', null, f.text))));
    } else if (a.findings) {
      body = el('p', { class: 'small', style: 'margin:0' }, '✓ Follows the ' + (checked.length === 1 ? 'rule' : checked.length + ' rules and skills') + ' that apply.');
    } else {
      body = el('p', { class: 'muted small', style: 'margin:0' }, 'The AI didn’t report on the rules for this file. Run the review again to retry.');
    }
    return el('div', { class: 'card' }, head, body,
      checked.length ? el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Checked against: ' + checked.join(', ')) : null);
  }

  function build(d) {
    const page = el('div', { class: 'detail' });
    root.append(page);
    if (!d.exists) {
      page.append(el('h1', null, d.name), el('p', { class: 'muted' }, d.missingText || 'This file has no uncommitted changes any more.'));
      return;
    }
    const isPr = d.mode === 'pr';
    const a = d.analysis;
    page.append(
      el('div', { class: 'muted small mono' }, d.dir ? d.dir + '/' : ''),
      el('h1', null, d.name),
      el('div', { class: 'meta' },
        el('span', { class: 'pill info' }, d.area),
        el('span', { class: 'pill muted' }, d.categoryLabel),
        el('span', null, d.statusWord),
        d.binary ? el('span', { class: 'muted' }, 'binary') : el('span', { class: 'mono' }, el('span', { class: 'add' }, '+' + d.added), ' ', el('span', { class: 'del' }, '−' + d.deleted)),
        a ? el('span', { class: 'pill ' + a.risk }, RISK[a.risk]) : null,
        d.analysedBy ? el('span', { class: 'muted small' }, 'Reviewed by ' + d.analysedBy) : null,
      ),
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn' + (d.decision === 'approved' ? ' on-approve' : ''),
          'aria-pressed': String(d.decision === 'approved'),
          onclick: () => post({ type: 'decide', decision: 'approved' }),
        }, d.decision === 'approved' ? '✓ Approved' : 'Approve file'),
        el('button', {
          class: 'btn secondary' + (d.decision === 'changes' ? ' on-changes' : ''),
          'aria-pressed': String(d.decision === 'changes'),
          onclick: () => post({ type: 'decide', decision: 'changes' }),
        }, d.decision === 'changes' ? 'Changes requested' : 'Request changes'),
        isPr
          ? el('button', { class: 'btn secondary', onclick: () => post({ type: 'openWeb' }) }, 'Open on ' + d.hostLabel)
          : el('button', { class: 'btn secondary', onclick: () => post({ type: 'openDiff' }) }, 'Open side-by-side diff'),
        d.status !== 'D' ? el('button', { class: 'btn secondary', onclick: () => post({ type: 'openFile' }) }, isPr ? 'Open local copy' : 'Edit file') : null,
      ),
    );
    // Native append() would print a null as the text "null".
    if (isPr) page.append(el('div', { class: 'muted small' }, 'File approvals stay in the editor. Post your overall review from the ReviewLens panel.'));

    if (isPr) {
      const open = d.threads.filter((t) => t.resolvable && !t.resolved).length;
      const elsewhere = d.threads.filter((t) => t.row < 0);
      page.append(el('div', { class: 'card' },
        el('div', { style: 'display:flex;align-items:center;gap:8px' },
          el('h2', { class: 'section-title', style: 'flex:1;margin:0' }, 'Comments from ' + d.hostLabel),
          el('button', { class: 'btn secondary', disabled: d.refreshing, title: 'Get the latest comments from ' + d.hostLabel, onclick: () => post({ type: 'refresh' }) }, d.refreshing ? 'Refreshing…' : 'Refresh')),
        el('div', { class: 'small' },
          d.threads.length
            ? d.threads.length + ' thread' + (d.threads.length === 1 ? '' : 's') + (open ? ', ' + open + ' open' : '') + '. '
            : 'No comments on this file yet. ',
          d.canComment
            ? 'The same threads as on ' + d.hostLabel + '. Click + next to a line below to comment; comments, replies and resolves post to ' + d.hostLabel + '. Press Refresh to see new ones from teammates.'
            : 'This ' + (d.hostLabel === 'GitLab' ? 'merge' : 'pull') + ' request is no longer open, so comments are read-only.',
        ),
        elsewhere.length
          ? el('div', { style: 'margin-top:8px' },
              el('div', { class: 'small muted' }, 'Not on the lines shown below (outdated, file-level, or past the end of the shown diff):'),
              elsewhere.map((t) => threadEl(t, d)))
          : null,
      ));
    }

    if (d.tooLarge) {
      page.append(el('div', { class: 'card muted' }, d.hostLabel + ' didn’t send this file’s changes because the diff is too large, so it can’t be reviewed by AI here. Open it on ' + d.hostLabel + ' instead.'));
    } else if (d.skipAi) {
      page.append(el('div', { class: 'card muted' }, 'This file is not sent to the AI (binary, deleted, lockfile or build output).'));
    } else if (!a) {
      page.append(el('div', { class: 'banner' },
        el('span', { style: 'flex:1;min-width:220px' }, 'This version of the file has not been reviewed by AI yet. Nothing is sent until you run the review.'),
        el('button', { class: 'btn', disabled: d.running, onclick: () => post({ type: 'runOne' }) }, d.running ? 'Reviewing…' : 'Run AI on this file'),
      ));
      const upcoming = d.rulesOn ? rulesCard(d, null) : null;
      if (upcoming) page.append(upcoming);
    } else {
      page.append(
        el('div', { class: 'card' }, el('h2', { class: 'section-title' }, 'Why it changed'), el('p', { class: 'why' }, a.why || '—')),
        el('div', { class: 'card' }, el('h2', { class: 'section-title' }, 'What changed'),
          a.what.length ? el('ul', { style: 'margin:0;padding-left:20px' }, a.what.map((w) => el('li', null, w))) : el('p', { class: 'muted', style: 'margin:0' }, '—')),
        el('div', { class: 'card' }, el('h2', { class: 'section-title' }, 'Possible impact'),
          a.impacts.length
            ? a.impacts.map((i) => el('div', { class: 'impact' },
                el('span', { class: 'pill ' + i.level }, i.level[0].toUpperCase() + i.level.slice(1)),
                el('div', null, el('div', { class: 'kind' }, i.kind), el('div', null, i.text))))
            : el('p', { class: 'muted', style: 'margin:0' }, 'No notable impact found.')),
      );
      const rules = rulesCard(d, a);
      if (rules) page.append(rules);
    }

    if (d.rows.length) {
      page.append(el('div', null,
        el('h2', { class: 'section-title' }, 'Changes' + (d.diffTruncated ? ' (first ' + d.rows.length + ' lines)' : '')),
        diffView(d),
      ));
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'detail') {
      if (last && msg.detail.path !== last.path) {
        composing = null;
        replying.clear();
      }
      last = msg.detail;
      draw();
    } else if (msg.type === 'done') {
      busy.delete(msg.key);
      if (msg.ok) {
        delete drafts[msg.key];
        persist();
        if (msg.key.startsWith('new:')) composing = null;
        if (msg.key.startsWith('reply:')) {
          const id = msg.key.slice(6);
          replying.delete(id);
          if (pendingResolve.delete(id)) send({ type: 'resolve', threadId: id, resolved: true }, 'resolve:' + id);
        }
      } else if (msg.key.startsWith('reply:')) {
        pendingResolve.delete(msg.key.slice(6));
      }
      draw();
    }
  });
  post({ type: 'ready' });
})();
