import { describe, it, expect } from 'vitest';
import { budgetCardModel } from '../src/gui/app/lib/budget-card.js';

const base = { project_id: 'acme', confirmed_minutes: 60, scheduled_minutes: 30 };

describe('budgetCardModel (#173): capped, 0h cap, uncapped and snoozed stay distinct', () => {
  it('capped and under: no overflow, no marker', () => {
    const m = budgetCardModel({ ...base, assigned_minutes: 600, snoozed: false });
    expect(m.state).toBe('capped');
    expect(m.over).toBe(false);
    expect(m.markAt).toBeNull();
    expect(m.label).toMatch(/10h assigned$/);
  });

  it('capped and over: red overflow with a marker at the cap line', () => {
    const m = budgetCardModel({ ...base, assigned_minutes: 60, snoozed: false });
    expect(m.over).toBe(true);
    expect(m.widths.schedOver).toBeGreaterThan(0);
    expect(m.markAt).toBeCloseTo((60 / 90) * 100);
    expect(m.label).toMatch(/1h assigned \(\+50%\)$/);
  });

  it('a real 0h cap: any activity is over, the marker sits at 0', () => {
    const m = budgetCardModel({ ...base, assigned_minutes: 0, snoozed: false });
    expect(m.state).toBe('capped');
    expect(m.over).toBe(true);
    expect(m.markAt).toBe(0);
    expect(m.widths.confirmedOver + m.widths.schedOver).toBeCloseTo(100);
    expect(m.label).toMatch(/0h assigned \(over a 0h cap\)$/);
  });

  it('uncapped: infinity, never over', () => {
    const m = budgetCardModel({ ...base, assigned_minutes: null, snoozed: false });
    expect(m.state).toBe('uncapped');
    expect(m.over).toBe(false);
    expect(m.markAt).toBeNull();
    expect(m.label).toMatch(/∞ assigned$/);
  });

  it('snoozed: labeled snoozed, never over, activity drawn plain', () => {
    const m = budgetCardModel({ ...base, assigned_minutes: null, snoozed: true });
    expect(m.state).toBe('snoozed');
    expect(m.over).toBe(false);
    expect(m.markAt).toBeNull();
    expect(m.widths.confirmedOver + m.widths.schedOver).toBe(0);
    expect(m.label).toMatch(/· snoozed$/);
    expect(m.label).not.toMatch(/∞/);
  });
});
