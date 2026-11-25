(function () {
  const vscode = acquireVsCodeApi();
  const { el, RISK } = window.acr;
  const root = document.getElementById('root');

  function post(msg) { vscode.postMessage(msg); }

  function diffView(lines) {
    return el('div', { class: 'diff' }, lines.map((l) => {
      const cls = l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('---') || l.startsWith('+++') || l.startsWith('new file')
        ? 'h'
        : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '';
      return el('div', { class: cls }, l || ' ');
    }));
  }

  function render(d) {
    root.replaceChildren();
    const page = el('div', { class: 'detail' });
    root.append(page);
    if (!d.exists) {
      page.append(el('h1', null, d.name), el('p', { class: 'muted' }, 'This file has no uncommitted changes any more.'));
      return;
    }
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
        el('button', { class: 'btn secondary', onclick: () => post({ type: 'openDiff' }) }, 'Open side-by-side diff'),
        d.status !== 'D' ? el('button', { class: 'btn secondary', onclick: () => post({ type: 'openFile' }) }, 'Edit file') : null,
      ),
    );

    if (d.skipAi) {
      page.append(el('div', { class: 'card muted' }, 'This file is not sent to the AI (binary, deleted, lockfile or build output).'));
    } else if (!a) {
      page.append(el('div', { class: 'banner' },
        el('span', { style: 'flex:1;min-width:220px' }, 'This version of the file has not been reviewed by AI yet. Nothing is sent until you run the review.'),
        el('button', { class: 'btn', disabled: d.running, onclick: () => post({ type: 'runOne' }) }, d.running ? 'Reviewing…' : 'Run AI on this file'),
      ));
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
    }

    if (d.diffLines.length) {
      page.append(el('div', null,
        el('h2', { class: 'section-title' }, 'Changes' + (d.diffTruncated ? ' (first ' + d.diffLines.length + ' lines)' : '')),
        diffView(d.diffLines),
      ));
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'detail') render(msg.detail);
  });
  post({ type: 'ready' });
})();
