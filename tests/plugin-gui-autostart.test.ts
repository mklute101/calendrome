import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs plugin hook, no type declarations
import { isStale, opensPlanner, resolveRepoPath } from '../plugin/hooks/gui-autostart.mjs';

describe('plugin gui-autostart hook', () => {
  const prompt = (p: string) => ({ hook_event_name: 'UserPromptSubmit', prompt: p });
  const skill = (s: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: s },
  });

  it('fires on planner slash commands', () => {
    expect(opensPlanner(prompt('/calendrome:today'))).toBe(true);
    expect(opensPlanner(prompt('/calendrome:week'))).toBe(true);
    expect(opensPlanner(prompt('/calendrome:today wrap'))).toBe(true);
    expect(opensPlanner(prompt('/today'))).toBe(true);
  });

  it('ignores other prompts and commands', () => {
    expect(opensPlanner(prompt('good morning'))).toBe(false);
    expect(opensPlanner(prompt('/calendrome:block 1h on ACME-42'))).toBe(false);
    expect(opensPlanner(prompt('/todays-tip'))).toBe(false);
    expect(opensPlanner(prompt('run /calendrome:today'))).toBe(false);
  });

  it('fires on Skill tool calls for the planner skills only', () => {
    expect(opensPlanner(skill('calendrome:today'))).toBe(true);
    expect(opensPlanner(skill('calendrome:week'))).toBe(true);
    expect(opensPlanner(skill('calendrome:status'))).toBe(false);
    expect(opensPlanner(skill('today'))).toBe(false);
    expect(
      opensPlanner({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
    ).toBe(false);
  });

  it('tolerates junk payloads', () => {
    expect(opensPlanner(null)).toBe(false);
    expect(opensPlanner({})).toBe(false);
    expect(opensPlanner({ hook_event_name: 'UserPromptSubmit' })).toBe(false);
  });

  it('resolves the repo path from settings, else the default', () => {
    expect(resolveRepoPath('', '/home/u')).toBe('/home/u/dev/tools/calendrome');
    expect(resolveRepoPath('---\ncalendrome_repo_path: ~/src/cal\n---', '/home/u')).toBe(
      '/home/u/src/cal',
    );
    expect(resolveRepoPath('calendrome_repo_path: "/opt/cal"', '/home/u')).toBe('/opt/cal');
  });

  it('flags a GUI as stale only when its own entry was rebuilt after it started', () => {
    const entry = '/repo/dist/src/gui/server.js';
    const proc = { startMs: 1000, entryPath: entry };
    expect(isStale(proc, entry, 2000)).toBe(true);
    expect(isStale(proc, entry, 500)).toBe(false);
    expect(isStale({ ...proc, entryPath: '/other/dist/src/gui/server.js' }, entry, 2000)).toBe(false);
    expect(isStale({ ...proc, startMs: NaN }, entry, 2000)).toBe(false);
    expect(isStale(null, entry, 2000)).toBe(false);
    // ps start times are whole seconds: a build later in the same second is not stale
    expect(isStale({ ...proc, startMs: 5000 }, entry, 5700)).toBe(false);
  });
});
