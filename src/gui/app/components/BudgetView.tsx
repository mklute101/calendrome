import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../api';
import type { BudgetEnvelope, EnvelopeMove, ProjectMeta, SupplyPayload } from '../types';
import { buildProjectMeta, colorOf } from '../lib/colors';
import { addDays, fmtDate, fmtHours, getMonday } from '../lib/dates';
import { usePolling } from '../hooks/usePolling';
import { useToasts } from './Toasts';

/**
 * The budget view (#106 M2) — YNAB's category screen, hours edition.
 * Envelope rows grouped by category (work first) then project, with
 * Assigned / Activity / Available columns, the funding status line,
 * and the colored Available pill. Writes: inline assign (click the
 * Assigned cell) and click-to-pull (click an underfunded/overspent
 * pill → "Cover from…"), both through /api/assign + /api/pull —
 * the same core functions as the MCP tools. Recent Moves is the pull
 * audit trail; every move undoes via the reverse pull.
 */
export function BudgetView({
  categoryView,
  setCategoryView,
}: {
  categoryView: string;
  setCategoryView: (v: string) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [envelopes, setEnvelopes] = useState<BudgetEnvelope[] | null>(null);
  const [supply, setSupply] = useState<SupplyPayload | null>(null);
  const [moves, setMoves] = useState<EnvelopeMove[]>([]);
  const [meta, setMeta] = useState<ProjectMeta>({});
  const [error, setError] = useState<string | null>(null);
  const [movesOpen, setMovesOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [pullFor, setPullFor] = useState<string | null>(null);
  const seq = useRef(0);
  const { show } = useToasts();

  const refetch = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const [projects, env, mv, sup] = await Promise.all([
        api.fetchProjects(),
        api.fetchEnvelopes(weekStart),
        api.fetchMoves(weekStart),
        api.fetchSupply(weekStart),
      ]);
      if (mySeq !== seq.current) return; // stale response — drop it
      setMeta(buildProjectMeta(projects));
      setEnvelopes(env.envelopes);
      setMoves(mv.moves);
      setSupply(sup);
      setError(null);
    } catch (err) {
      if (mySeq !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [weekStart]);

  useEffect(() => {
    setEnvelopes(null);
    void refetch();
  }, [refetch]);

  // Same 5s cadence as the week view; paused while a cell is being
  // edited or the pull menu is open so a poll can't yank the UI away.
  usePolling(refetch, 5000, editing !== null || pullFor !== null);

  const visible = useMemo(() => {
    if (!envelopes) return [];
    if (categoryView === 'all') return envelopes;
    return envelopes.filter(
      (e) => (meta[e.project_id]?.category_id ?? 'work') === categoryView,
    );
  }, [envelopes, meta, categoryView]);

  const groups = useMemo(() => buildGroups(visible, meta), [visible, meta]);

  /** envelope key → title, for naming the two sides of a move. */
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of envelopes ?? []) m.set(keyOf(e), e.title);
    return m;
  }, [envelopes]);
  const sideName = (type: string | null, id: string | null): string =>
    type === null || id === null ? 'Unassigned' : (titles.get(`${type}:${id}`) ?? `${type} ${id}`);

  const commitAssign = useCallback(
    async (row: BudgetEnvelope, minutes: number) => {
      setEditing(null);
      // Optimistic: show the new assignment while the POST flies.
      setEnvelopes(
        (rows) =>
          rows?.map((e) =>
            keyOf(e) === keyOf(row)
              ? {
                  ...e,
                  assigned: minutes,
                  available:
                    minutes -
                    (e.activity.confirmed_minutes + e.activity.scheduled_minutes),
                }
              : e,
          ) ?? rows,
      );
      try {
        await api.assignEnvelope({
          envelope_type: row.envelope_type,
          envelope_id: row.envelope_id,
          week_start: weekStart,
          minutes,
        });
        show({ kind: 'info', message: `Assigned ${fmtHours(minutes)} to ${row.title}` });
      } catch (err) {
        show({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await refetch();
      }
    },
    [weekStart, refetch, show],
  );

  const runPull = useCallback(
    async (
      from: BudgetEnvelope | null,
      to: BudgetEnvelope | null,
      minutes: number,
      note: string,
    ) => {
      setPullFor(null);
      const args = {
        week_start: weekStart,
        from: from ? { type: from.envelope_type, id: from.envelope_id } : undefined,
        to: to ? { type: to.envelope_type, id: to.envelope_id } : undefined,
        minutes,
        note,
      };
      try {
        await api.pullEnvelope(args);
        show({
          kind: 'info',
          message: `Covered ${fmtHours(minutes)}: ${from?.title ?? 'Unassigned'} → ${to?.title ?? 'Unassigned'}`,
          undo: async () => {
            // Undo = the reverse pull, from/to swapped.
            await api.pullEnvelope({
              week_start: weekStart,
              from: args.to,
              to: args.from,
              minutes,
              note: 'undo',
            });
            await refetch();
          },
        });
      } catch (err) {
        show({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await refetch();
      }
    },
    [weekStart, refetch, show],
  );

  const undoMove = useCallback(
    async (m: EnvelopeMove) => {
      try {
        await api.pullEnvelope({
          week_start: m.week_start,
          from: m.to_type && m.to_id ? { type: m.to_type, id: m.to_id } : undefined,
          to: m.from_type && m.from_id ? { type: m.from_type, id: m.from_id } : undefined,
          minutes: m.minutes,
          note: 'undo',
        });
        show({
          kind: 'info',
          message: `Undid ${fmtHours(m.minutes)}: ${sideName(m.from_type, m.from_id)} → ${sideName(m.to_type, m.to_id)}`,
        });
      } catch (err) {
        show({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await refetch();
      }
    },
    [refetch, show, sideName],
  );

  // "Cover from…" candidates: everything visible with hours to spare.
  const sourcesFor = useCallback(
    (target: BudgetEnvelope) =>
      visible.filter((e) => keyOf(e) !== keyOf(target) && e.available > 0),
    [visible],
  );

  return (
    <>
      <header>
        <h1>Calendrome</h1>
        <div className="nav-group">
          <a className="nav-btn" href="#/">
            ← Week
          </a>
          <span className="nav-sep" />
          <button
            className="nav-btn"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            aria-label="Previous week"
          >
            ←
          </button>
          <span className="week-label">
            {fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}
          </span>
          <button
            className="nav-btn"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            aria-label="Next week"
          >
            →
          </button>
          <button className="nav-btn" onClick={() => setWeekStart(getMonday(new Date()))}>
            Today
          </button>
          <span className="nav-sep" />
          <button
            className={`nav-btn${categoryView === 'work' ? ' active' : ''}`}
            onClick={() => setCategoryView('work')}
            title="Show only work projects (screen-share safe)"
          >
            Work
          </button>
          <button
            className={`nav-btn${categoryView === 'all' ? ' active' : ''}`}
            onClick={() => setCategoryView('all')}
            title="Show every category"
          >
            All
          </button>
          <span className="nav-sep" />
          <button
            className={`nav-btn${movesOpen ? ' active' : ''}`}
            onClick={() => setMovesOpen(!movesOpen)}
            title="Recent Moves — the pull history"
          >
            Moves
          </button>
        </div>
      </header>

      {error && <div className="empty">Error: {error}</div>}
      {envelopes && !error && (
        <main className="budget-view">
          {supply && (
            <div
              className={`supply-strip${supply.to_be_assigned_minutes < 0 ? ' overcommitted' : ''}`}
              title="Supply = category windows − meetings − blocks + opens. Negative To Assign = you promised more hours than the week holds."
            >
              <span>supply {fmtHours(supply.total_supply_minutes)}</span>
              <span className="nav-sep" />
              <span>assigned {fmtHours(supply.assigned_minutes)}</span>
              <span className="nav-sep" />
              <span className="supply-tba">
                {supply.to_be_assigned_minutes < 0
                  ? `overcommitted by ${fmtHours(-supply.to_be_assigned_minutes)}`
                  : `to assign ${fmtHours(supply.to_be_assigned_minutes)}`}
              </span>
            </div>
          )}
          {groups.length === 0 ? (
            <div className="empty">
              No envelopes yet — envelopes appear once you have projects, goals,
              or habits. Ask Claude to <code>create_goal</code> or set a weekly
              budget, then come back.
            </div>
          ) : (
            groups.map((g) => (
              <section className="env-group" key={g.category}>
                <h2 className="env-group-head">{g.category}</h2>
                <div className="env-table">
                  <div className="env-row env-head-row">
                    <span />
                    <span className="env-cell">Assigned</span>
                    <span className="env-cell">Activity</span>
                    <span className="env-cell">Available</span>
                  </div>
                  {g.rows.map((row) => (
                    <EnvelopeRowView
                      key={keyOf(row)}
                      row={row}
                      color={colorOf(meta, row.project_id)}
                      editing={editing === keyOf(row)}
                      onEdit={() => setEditing(keyOf(row))}
                      onCancelEdit={() => setEditing(null)}
                      onCommit={(minutes) => void commitAssign(row, minutes)}
                      pullOpen={pullFor === keyOf(row)}
                      onTogglePull={() =>
                        setPullFor(pullFor === keyOf(row) ? null : keyOf(row))
                      }
                      sources={sourcesFor(row)}
                      onPull={(source, minutes) =>
                        void runPull(source, row, minutes, `cover ${row.title}`)
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </main>
      )}
      {movesOpen && (
        <aside className="tasks-panel moves-panel">
          <div className="tasks-panel-head">
            <strong>Recent Moves</strong>
            <span className="spacer" />
            <button className="nav-btn" onClick={() => setMovesOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="tasks-panel-body">
            {moves.length === 0 ? (
              <div className="empty">No moves this week.</div>
            ) : (
              moves.map((m) => (
                <div className="move-row" key={m.id}>
                  <div className="move-main">
                    <span className="move-minutes">{fmtHours(m.minutes)}</span>
                    <span className="move-path">
                      {sideName(m.from_type, m.from_id)} → {sideName(m.to_type, m.to_id)}
                    </span>
                    <button className="task-action" onClick={() => void undoMove(m)}>
                      Undo
                    </button>
                  </div>
                  {m.note && <div className="move-note">{m.note}</div>}
                </div>
              ))
            )}
          </div>
        </aside>
      )}
    </>
  );
}

function keyOf(e: { envelope_type: string; envelope_id: string }): string {
  return `${e.envelope_type}:${e.envelope_id}`;
}

interface Group {
  category: string;
  rows: BudgetEnvelope[];
}

/**
 * Category groups, work first, then alphabetical; inside a group the
 * rows sort by project, with the project envelope leading its goals
 * and habits — the YNAB "category rows in groups" shape.
 */
function buildGroups(rows: BudgetEnvelope[], meta: ProjectMeta): Group[] {
  const TYPE_ORDER: Record<string, number> = { project: 0, goal: 1, habit: 2 };
  const byCat = new Map<string, BudgetEnvelope[]>();
  for (const e of rows) {
    const cat = meta[e.project_id]?.category_id ?? 'work';
    const list = byCat.get(cat) ?? [];
    list.push(e);
    byCat.set(cat, list);
  }
  return [...byCat.entries()]
    .sort(
      (a, b) =>
        Number(a[0] !== 'work') - Number(b[0] !== 'work') || a[0].localeCompare(b[0]),
    )
    .map(([category, list]) => ({
      category,
      rows: list.sort(
        (a, b) =>
          a.project_id.localeCompare(b.project_id) ||
          TYPE_ORDER[a.envelope_type] - TYPE_ORDER[b.envelope_type] ||
          a.title.localeCompare(b.title),
      ),
    }));
}

const FUNDING_LABEL: Record<BudgetEnvelope['funding'], string> = {
  on_track: 'on track',
  underfunded: 'underfunded',
  overspent: 'overspent',
  snoozed: 'snoozed',
};

function EnvelopeRowView({
  row,
  color,
  editing,
  onEdit,
  onCancelEdit,
  onCommit,
  pullOpen,
  onTogglePull,
  sources,
  onPull,
}: {
  row: BudgetEnvelope;
  color: string;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onCommit: (minutes: number) => void;
  pullOpen: boolean;
  onTogglePull: () => void;
  sources: BudgetEnvelope[];
  onPull: (source: BudgetEnvelope, minutes: number) => void;
}) {
  const activityTotal =
    row.activity.confirmed_minutes + row.activity.scheduled_minutes;
  const assigned = row.assigned ?? 0;
  const pct = assigned > 0 ? Math.min(100, (activityTotal / assigned) * 100) : 0;
  // Pulls fix an assignment gap: overspend first, else the uncovered ask.
  const shortfall =
    row.funding === 'overspent' ? -row.available : row.needed_minutes;
  const pullable =
    (row.funding === 'overspent' || row.funding === 'underfunded') && shortfall > 0;

  return (
    <div
      className={`env-row${row.envelope_type !== 'project' ? ' env-sub' : ''}`}
      style={{ '--c': color } as React.CSSProperties}
    >
      <span className="env-name">
        <span className="env-title-line">
          <span className="env-title">{row.title}</span>
          {row.envelope_type !== 'project' && (
            <span className="env-type">{row.envelope_type}</span>
          )}
          {row.week_score && (
            <span className="habit-frac">
              {row.week_score.done}/{row.week_score.target}
            </span>
          )}
        </span>
        <span className="goal-bar env-bar">
          <span className="goal-bar-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className={`env-status env-status-${row.funding}`}>{row.status_line}</span>
      </span>
      <span className="env-cell env-assigned">
        {editing ? (
          <AssignInput
            initialHours={row.assigned === null ? 0 : row.assigned / 60}
            onCommit={onCommit}
            onCancel={onCancelEdit}
          />
        ) : (
          <button
            className="env-assigned-btn"
            title="Click to assign hours for this week"
            onClick={onEdit}
          >
            {row.assigned === null ? '—' : fmtHours(row.assigned)}
          </button>
        )}
      </span>
      <span className="env-cell">{fmtHours(activityTotal)}</span>
      <span className="env-cell env-available">
        <button
          className={`pill pill-${row.funding}`}
          title={
            pullable
              ? `${FUNDING_LABEL[row.funding]} — click to cover from another envelope`
              : FUNDING_LABEL[row.funding]
          }
          onClick={pullable ? onTogglePull : undefined}
          disabled={!pullable}
        >
          {fmtHours(row.available)}
        </button>
        {pullOpen && (
          <div className="pull-menu">
            <div className="pull-menu-head">
              Cover {fmtHours(shortfall)} from…
            </div>
            {sources.length === 0 ? (
              <div className="empty">Nothing has hours to spare.</div>
            ) : (
              sources.map((s) => (
                <button
                  className="snooze-option"
                  key={keyOf(s)}
                  onClick={() => onPull(s, Math.min(shortfall, s.available))}
                >
                  {s.title}
                  <span className="pull-surplus">{fmtHours(s.available)} free</span>
                </button>
              ))
            )}
          </div>
        )}
      </span>
    </div>
  );
}

/**
 * Edit-in-place for the Assigned cell (YNAB's inline assign). Hours
 * in, decimals fine; Enter/blur commits (converted to minutes),
 * Escape cancels.
 */
function AssignInput({
  initialHours,
  onCommit,
  onCancel,
}: {
  initialHours: number;
  onCommit: (minutes: number) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(String(Number(initialHours.toFixed(2))));
  // Enter commits and then the input blurs on unmount — the ref makes
  // sure the pair can only ever produce one POST.
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0) {
      onCancel();
      return;
    }
    onCommit(Math.round(hours * 60));
  };
  return (
    <input
      className="assign-input"
      type="number"
      min="0"
      step="0.25"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          done.current = true; // suppress the unmount blur
          onCancel();
        }
      }}
    />
  );
}
