import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PANELS, PRESETS, REGIONS, activate, attach, detach, locate, move, normalize, putAway, setMode, visiblePanels } from '../js/core/layout.js';

const all = (layout) => [...REGIONS.flatMap((r) => layout.regions[r]), ...layout.detached, ...layout.away].sort();

test('every preset holds every panel exactly once and survives normalize unchanged', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.deepEqual(all(preset), Object.keys(PANELS).sort(), name);
    assert.deepEqual(normalize(preset), preset, name);
  }
});

test('normalize repairs junk from disk', () => {
  const layout = normalize({ regions: { left: ['board', 'board', 'nope'], center: 'x' }, active: { left: 'feed' }, modes: { left: 'grid' }, detached: ['console'] });
  assert.deepEqual(all(layout), Object.keys(PANELS).sort());
  assert.deepEqual(layout.regions.left, ['board']);
  assert.equal(layout.active.left, 'board', 'active falls back to a panel that is there');
  assert.equal(layout.modes.left, 'stack', 'unknown mode falls back to the default');
  assert.deepEqual(layout.detached, ['console']);
  assert.deepEqual(normalize(null), PRESETS.Learn);
});

test('moving a panel takes it out of where it was and makes it active', () => {
  const start = PRESETS.Learn;
  const next = move(start, 'console', 'center', 0);
  assert.deepEqual(next.regions.center, ['console', 'photo', 'notes']);
  assert.equal(next.active.center, 'console');
  assert.ok(!next.regions.right.includes('console'));
  assert.equal(start.regions.right.includes('console'), true, 'the input is not changed');
  const moved = move(next, 'playbook', 'right');
  assert.equal(moved.active.right, 'playbook');
});

test('moving the active tab away activates the next one', () => {
  const next = move(PRESETS.Learn, 'playbook', 'bottom');
  assert.equal(next.active.right, 'wiki');
  assert.equal(next.active.bottom, 'playbook');
});

test('detach and attach', () => {
  const out = detach(PRESETS.Learn, 'console');
  assert.deepEqual(locate(out, 'console'), { detached: true });
  assert.equal(visiblePanels(out).has('console'), false);
  const back = attach(out, 'console', 'bottom');
  assert.deepEqual(locate(back, 'console'), { region: 'bottom', index: 0 });
  assert.deepEqual(back.detached, []);
});

test('stack regions show every panel, tab regions only the active one', () => {
  const shown = visiblePanels(PRESETS.Learn);
  assert.deepEqual([...shown].sort(), ['board', 'inspector', 'photo', 'playbook'].sort());
  const tabbed = setMode(PRESETS.Learn, 'left', 'tabs');
  assert.deepEqual([...visiblePanels(tabbed)].filter((p) => ['board', 'inspector'].includes(p)), ['board']);
  assert.deepEqual(activate(tabbed, 'inspector').active.left, 'inspector');
});

test('bad requests leave the layout alone', () => {
  const start = PRESETS.Learn;
  assert.equal(move(start, 'nope', 'left'), start);
  assert.equal(move(start, 'board', 'top'), start);
  assert.equal(setMode(start, 'left', 'grid'), start);
  assert.equal(activate(detach(start, 'wiki'), 'wiki').detached.includes('wiki'), true);
});

test('a detached panel comes back where it was, even if that region emptied', () => {
  const out = detach(PRESETS.Learn, 'photo');
  assert.deepEqual(out.regions.center, ['notes']);
  assert.deepEqual(out.origins.photo, { region: 'center', index: 0 });
  const back = attach(out, 'photo');
  assert.deepEqual(back.regions.center, ['photo', 'notes']);
  assert.equal(back.active.center, 'photo');
  assert.deepEqual(back.origins, {});
  const inspector = attach(detach(PRESETS.Learn, 'inspector'), 'inspector');
  assert.deepEqual(inspector.regions.left, ['board', 'inspector'], 'same place in the stack');
  assert.deepEqual(attach(detach(PRESETS.Learn, 'photo'), 'photo', 'bottom').regions.bottom, ['photo'], 'an explicit region wins');
});

test('origins survive saving and junk origins are dropped', () => {
  const saved = JSON.parse(JSON.stringify(detach(PRESETS.Learn, 'console')));
  assert.deepEqual(normalize(saved).origins, { console: { region: 'right', index: 2 } });
  const junk = normalize({ ...saved, origins: { console: { region: 'top', index: 1 }, board: { region: 'left', index: 0 } } });
  assert.deepEqual(junk.origins, {}, 'bad region dropped, and board is not detached');
});

test('detaching a panel that is already detached keeps the origin it will return to', () => {
  const start = normalize(PRESETS.Learn);
  const once = detach(start, 'console');
  const again = detach(once, 'console');
  assert.equal(again, once);
  assert.deepEqual(again.origins.console, once.origins.console);
  assert.ok(once.origins.console);
});

test('with the assistant off no preset holds the Agent panel, and it comes back at the end of the right-hand tabs', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const off = normalize(preset, { assistant: 'off' });
    assert.deepEqual(all(off), Object.keys(PANELS).filter((p) => p !== 'assistant').sort(), name);
    assert.equal(locate(off, 'assistant'), null, name);
    assert.equal(Object.keys(off.origins).includes('assistant'), false, name);
    for (const region of REGIONS) assert.notEqual(off.active[region], 'assistant', `${name} ${region}`);
    const back = normalize(off, { assistant: 'on' });
    assert.deepEqual(all(back), Object.keys(PANELS).sort(), name);
    assert.deepEqual(locate(back, 'assistant'), { region: 'right', index: back.regions.right.length - 1 }, name);
  }
});

test('turning the assistant off repairs the active tab that was the Agent panel, and a detached one is dropped', () => {
  const active = { ...PRESETS.Learn, active: { ...PRESETS.Learn.active, right: 'assistant' } };
  assert.equal(normalize(active, { assistant: 'off' }).active.right, 'playbook');
  const detached = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, right: PRESETS.Learn.regions.right.filter((p) => p !== 'assistant') },
    detached: ['assistant'], origins: { assistant: { region: 'right', index: 6 } } };
  const off = normalize(detached, { assistant: 'off' });
  assert.deepEqual(off.detached, []);
  assert.deepEqual(off.origins, {});
});

test('visiblePanels leaves the Agent panel out while the assistant is off, even in a stacked region', () => {
  const stacked = setMode(PRESETS.Learn, 'right', 'stack');
  assert.ok(visiblePanels(stacked, { assistant: 'on' }).has('assistant'));
  assert.ok(visiblePanels(stacked).has('assistant'));
  assert.equal(visiblePanels(stacked, { assistant: 'off' }).has('assistant'), false);
  assert.equal(visiblePanels(PRESETS.Learn, { assistant: 'off' }).has('playbook'), true);
});

test('putting a panel away takes it out of every region and remembers where it was', () => {
  const away = putAway(PRESETS.Learn, 'console');
  assert.deepEqual(locate(away, 'console'), { away: true });
  assert.deepEqual(away.away, ['console']);
  assert.equal(visiblePanels(away).has('console'), false);
  assert.deepEqual(away.origins.console, { region: 'right', index: 2 });
  assert.equal(PRESETS.Learn.away.length, 0, 'the input is not changed');
  assert.equal(putAway(away, 'console'), away, 'a panel that is away stays as it is');
  assert.equal(putAway(PRESETS.Learn, 'nope'), PRESETS.Learn);
});

test('a panel that was active when put away hands the tab to the next one', () => {
  const away = putAway(PRESETS.Learn, 'playbook');
  assert.equal(away.active.right, 'wiki');
});

test('showing an away panel returns it to its origin, or the right region without one', () => {
  const back = attach(putAway(PRESETS.Learn, 'inspector'), 'inspector');
  assert.deepEqual(back.regions.left, ['board', 'inspector']);
  assert.deepEqual(back.away, []);
  assert.deepEqual(back.origins, {});
  const noOrigin = { ...PRESETS.Learn, regions: { ...PRESETS.Learn.regions, left: ['board'] }, away: ['inspector'] };
  assert.deepEqual(locate(attach(noOrigin, 'inspector'), 'inspector'), { region: 'right', index: 7 });
});

test('a panel is in exactly one place: moving, detaching or putting away leaves no copy behind', () => {
  let layout = putAway(PRESETS.Learn, 'timeline');
  layout = detach(layout, 'timeline');
  assert.deepEqual(layout.away, []);
  assert.deepEqual(layout.detached, ['timeline']);
  assert.deepEqual(layout.origins.timeline, { region: 'right', index: 3 }, 'the origin survives the hop from away to a window');
  layout = putAway(layout, 'timeline');
  assert.deepEqual(layout.detached, []);
  assert.deepEqual(layout.away, ['timeline']);
  assert.deepEqual(layout.origins.timeline, { region: 'right', index: 3 });
  layout = move(layout, 'timeline', 'bottom');
  assert.deepEqual(layout.away, []);
  assert.deepEqual(all(layout), Object.keys(PANELS).sort());
});

test('away survives saving; old layouts without it load; junk and duplicates are repaired', () => {
  const saved = JSON.parse(JSON.stringify(putAway(PRESETS.Learn, 'logic')));
  assert.deepEqual(normalize(saved), saved);
  const { away, ...old } = saved;
  assert.deepEqual(normalize(old).away, [], 'a layout saved before this state existed has none away');
  assert.deepEqual(all(normalize(old)), Object.keys(PANELS).sort());
  const messy = normalize({ ...saved, away: ['logic', 'logic', 'nope', 'board'], detached: ['logic'] });
  assert.deepEqual(messy.detached, ['logic']);
  assert.deepEqual(messy.away, [], 'a panel listed twice stays in the first place it was listed, and regions are read first');
  assert.ok(messy.regions.left.includes('board'));
  assert.deepEqual(all(messy), Object.keys(PANELS).sort());
  assert.deepEqual(normalize({ ...saved, away: 'x' }).away, []);
});

test('a layout saved by the version before the Panels menu loads unchanged', () => {
  const saved = { regions: { left: ['board', 'inspector'], center: ['photo'], right: ['playbook', 'wiki', 'console', 'timeline', 'terminal', 'assistant'], bottom: [] },
    active: { left: 'board', center: 'photo', right: 'wiki', bottom: null },
    modes: { left: 'stack', center: 'tabs', right: 'tabs', bottom: 'tabs' }, detached: ['logic'], origins: { logic: { region: 'right', index: 4 } } };
  const layout = normalize(saved);
  assert.deepEqual(layout, { ...saved, regions: { ...saved.regions, right: [...saved.regions.right, 'notes'] }, away: [] });
});

test('a layout saved with the removed Changes panel loads clean', () => {
  const base = normalize(PRESETS.Learn);
  const where = {
    'a region': { ...base, regions: { ...base.regions, left: ['board', 'feed', 'inspector'] } },
    detached: { ...base, detached: ['feed'] },
    away: { ...base, away: ['feed'] },
    'the active tab': { ...base, active: { ...base.active, left: 'feed' } },
    origins: { ...base, detached: ['feed'], origins: { feed: { region: 'left', index: 2 } } },
  };
  for (const [name, saved] of Object.entries(where)) {
    const layout = normalize(saved);
    assert.equal(JSON.stringify(layout).includes('feed'), false, `feed is gone from ${name}`);
    assert.deepEqual(all(layout), Object.keys(PANELS).sort(), `every panel is placed once (${name})`);
    assert.ok(layout.regions.left.includes(layout.active.left), `the active left tab is a panel that is there (${name})`);
  }
});

test('the Notes panel sits where the presets put it, and an old layout gains it', () => {
  assert.equal(PANELS.notes, 'Notes');
  assert.deepEqual(PRESETS.Learn.regions.center, ['photo', 'notes']);
  assert.deepEqual(PRESETS.Console.regions.right.slice(0, 3), ['playbook', 'wiki', 'notes']);
  assert.deepEqual(PRESETS.Analysis.regions.center.slice(0, 2), ['timeline', 'notes']);
  assert.ok(PRESETS.Wall.detached.includes('notes'));
  const old = JSON.parse(JSON.stringify(PRESETS.Learn));
  old.regions.center = ['photo'];
  assert.deepEqual(locate(normalize(old), 'notes'), { region: 'right', index: old.regions.right.length });
});

test('with the assistant off the Agent panel is not away either, and it comes back at the end of the right-hand tabs', () => {
  const away = putAway(PRESETS.Learn, 'assistant');
  const off = normalize(away, { assistant: 'off' });
  assert.deepEqual(off.away, []);
  assert.equal(locate(off, 'assistant'), null);
  assert.equal('assistant' in off.origins, false);
  assert.deepEqual(locate(normalize(off, { assistant: 'on' }), 'assistant'), { region: 'right', index: 6 });
});

test('every preset gives each detached panel an origin in a region, where the Learn preset has it', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const panel of preset.detached) {
      const origin = preset.origins[panel];
      assert.ok(origin && REGIONS.includes(origin.region), `${name}: ${panel}`);
      assert.deepEqual(origin, PRESETS.Learn.regions[origin.region].indexOf(panel) === -1 ? null : { region: origin.region, index: PRESETS.Learn.regions[origin.region].indexOf(panel) }, `${name}: ${panel} matches Learn`);
    }
    assert.deepEqual(Object.keys(preset.origins).sort(), [...preset.detached].sort(), `${name}: no origin for a panel that is not detached`);
  }
});

test('bringing a panel back from a preset window puts it where Learn has it', () => {
  assert.deepEqual(locate(attach(PRESETS.Console, 'board'), 'board'), { region: 'left', index: 0 });
  assert.deepEqual(locate(attach(PRESETS.Wall, 'console'), 'console'), { region: 'right', index: 0 }, 'Wall leaves the right region empty, so the index settles at the start');
  assert.equal(PRESETS.Wall.origins.console.index, 2);
  assert.deepEqual(locate(attach(PRESETS.Analysis, 'inspector'), 'inspector'), { region: 'left', index: 1 });
});
