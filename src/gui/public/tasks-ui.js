/*
 * Shared rendering for the tasks panel (index.html) and the full-page
 * tasks view (tasks.html) — #85.
 *
 * Read-only by design: rows display title, project, status, duration,
 * and due. There are intentionally no action buttons yet — making the
 * GUI write-capable (place / complete / snooze) is tracked separately.
 *
 * Exposes a single global `window.TasksUI`. Vanilla JS, no build step,
 * matching the inline style already used by index.html.
 */
(function () {
  const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const PRIORITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const PRIORITY_LABEL = {
    CRITICAL: 'Critical',
    HIGH: 'High',
    MEDIUM: 'Medium',
    LOW: 'Low',
  };
  const STATUS_LABEL = {
    NEW: 'New',
    SCHEDULED: 'Scheduled',
    IN_PROGRESS: 'In progress',
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDuration(min) {
    const m = Number(min) || 0;
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? h + 'h ' + rem + 'm' : h + 'h';
  }

  function fmtDue(due) {
    if (!due) return '';
    // Stored as ISO; show the date portion only.
    return String(due).slice(0, 10);
  }

  function compareTasks(a, b) {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return a.id - b.id;
  }

  // projectMeta: { [id]: { name, color, category_id } }
  function rowHtml(task, projectMeta) {
    const meta = projectMeta[task.project_id] || {};
    const color = meta.color || '#58a6ff';
    const projName = meta.name || task.project_id;
    const due = fmtDue(task.due);
    return (
      '<div class="task-row" style="--c:' + esc(color) + '">' +
      '<div class="task-row-main">' +
      '<span class="task-title">' + esc(task.title) + '</span>' +
      '<span class="task-dur">' + esc(fmtDuration(task.duration_minutes)) + '</span>' +
      '</div>' +
      '<div class="task-row-meta">' +
      '<span class="task-proj" style="--c:' + esc(color) + '">' + esc(projName) + '</span>' +
      '<span class="task-status status-' + esc(task.status) + '">' +
      esc(STATUS_LABEL[task.status] || task.status) + '</span>' +
      (due ? '<span class="task-due">due ' + esc(due) + '</span>' : '') +
      '</div>' +
      '</div>'
    );
  }

  // Group by priority tier, each tier collapsible with a count badge.
  function renderPriorities(container, tasks, projectMeta) {
    const sorted = tasks.slice().sort(compareTasks);
    let html = '';
    for (const p of PRIORITY_ORDER) {
      const group = sorted.filter((t) => t.priority === p);
      if (!group.length) continue;
      html +=
        '<section class="task-group">' +
        '<h3 class="task-group-head">' + esc(PRIORITY_LABEL[p]) +
        ' <span class="count-badge">' + group.length + '</span></h3>' +
        group.map((t) => rowHtml(t, projectMeta)).join('') +
        '</section>';
    }
    container.innerHTML = html || '<div class="empty">No pending tasks.</div>';
  }

  // Flat "Up Next" list with optional search / project filter / sort.
  function renderUpNext(container, tasks, projectMeta, opts) {
    opts = opts || {};
    let list = tasks.slice();
    const q = (opts.search || '').trim().toLowerCase();
    if (q) {
      list = list.filter((t) => {
        const hay = (t.title + ' ' + (t.notes || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    if (opts.projectFilter) {
      list = list.filter((t) => t.project_id === opts.projectFilter);
    }
    if (opts.sort === 'duration') {
      list.sort((a, b) => b.duration_minutes - a.duration_minutes);
    } else if (opts.sort === 'due') {
      list.sort((a, b) => {
        if (a.due === b.due) return a.id - b.id;
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      list.sort(compareTasks); // default: priority
    }
    container.innerHTML = list.length
      ? list.map((t) => rowHtml(t, projectMeta)).join('')
      : '<div class="empty">No matching tasks.</div>';
  }

  window.TasksUI = {
    esc: esc,
    fmtDuration: fmtDuration,
    fmtDue: fmtDue,
    compareTasks: compareTasks,
    rowHtml: rowHtml,
    renderPriorities: renderPriorities,
    renderUpNext: renderUpNext,
    PRIORITY_ORDER: PRIORITY_ORDER,
  };
})();
