import type { Goal, HabitScore, ProjectMeta } from '../types';
import { colorOf } from '../lib/colors';
import { fmtHours } from '../lib/dates';

/**
 * Read-only Goals + Habits sections for the side panel (M1 —
 * watchable). Goals show a progress bar (confirmed / target) and the
 * "Nh more needed this week" nag from `goalProgress`; a goal that
 * blew its date glows warn. Habits show the weekly frequency meter
 * (●●●○ done/target). Writes stay conversational for now — the
 * budget view (#/budget) is where the envelope becomes tactile.
 */
export function CommitmentSections({
  goals,
  habitScores,
  meta,
}: {
  goals: Goal[];
  habitScores: HabitScore[];
  meta: ProjectMeta;
}) {
  if (!goals.length && !habitScores.length) return null;
  return (
    <>
      {goals.length > 0 && (
        <section className="task-group">
          <h3 className="task-group-head">
            Goals <span className="count-badge">{goals.length}</span>
          </h3>
          {goals.map((g) => (
            <GoalItem key={g.id} goal={g} meta={meta} />
          ))}
        </section>
      )}
      {habitScores.length > 0 && (
        <section className="task-group">
          <h3 className="task-group-head">
            Habits <span className="count-badge">{habitScores.length}</span>
          </h3>
          {habitScores.map((h) => (
            <HabitItem key={h.habit_id} score={h} meta={meta} />
          ))}
        </section>
      )}
    </>
  );
}

function GoalItem({ goal, meta }: { goal: Goal; meta: ProjectMeta }) {
  const p = goal.progress;
  // Refill goals reset weekly — the bar tracks this week's pour;
  // by-date goals track the whole bucket.
  const [done, target] =
    p.flavor === 'by_date'
      ? [p.confirmed_minutes, p.target_minutes]
      : [p.week_confirmed, p.weekly_ask];
  const pct = target > 0 ? Math.min(100, (done / target) * 100) : 0;
  const color = colorOf(meta, goal.project_id);
  return (
    <div
      className={`goal-item${p.status === 'behind' ? ' behind' : ''}`}
      style={{ '--c': color } as React.CSSProperties}
    >
      <div className="goal-item-main">
        <span className="task-title">{goal.title}</span>
        <span className="task-dur">
          {fmtHours(done)} / {fmtHours(target)}
        </span>
      </div>
      <div className="goal-bar">
        <div className="goal-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="goal-item-status">
        {p.status === 'behind'
          ? 'Behind — the date passed with the bucket unfilled'
          : p.needed_this_week > 0
            ? `${fmtHours(p.needed_this_week)} more needed this week`
            : p.status === 'complete'
              ? 'Complete'
              : 'Funded this week'}
      </div>
    </div>
  );
}

function HabitItem({ score, meta }: { score: HabitScore; meta: ProjectMeta }) {
  const color = colorOf(meta, score.project_id);
  // Dot meter caps at 10 dots; the numeric fraction stays exact.
  const dots = Math.min(score.target, 10);
  const filled = Math.min(score.done, dots);
  return (
    <div className="habit-item" style={{ '--c': color } as React.CSSProperties}>
      <span className="task-title">{score.title}</span>
      <span className="habit-meter" title={`${score.done} of ${score.target} this week`}>
        <span className="habit-dots" aria-hidden="true">
          {'●'.repeat(filled)}
          {'○'.repeat(Math.max(0, dots - filled))}
        </span>
        <span className="habit-frac">
          {score.done}/{score.target}
        </span>
      </span>
    </div>
  );
}
