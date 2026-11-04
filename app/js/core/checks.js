// Playbook checks and step state, evaluated against the live board. Pure, so tests run in Node.
// Check kinds and their parameters are validated by the service (service/src/pcbv/playbooks.py);
// anything unexpected here simply fails the check rather than throwing.
//
// Guided: a step opens once the steps before it are done, and can be completed when its gates are
// confirmed, its required questions answered and its checks pass. Expert: every step is open, only
// destructive gates block completion, and failing checks are a warning.

import { headerName } from './format.js';

const list = (value) => (Array.isArray(value) ? value : []);

// What a console session or a decoded logic capture can recognise, in words (see pcbv.serialmgr.SIGNS).
const SIGN_NAMES = { bootloader: 'bootloader', autoboot: 'autoboot countdown', 'uboot-prompt': 'U-Boot prompt', env: 'printenv output',
  help: 'help output', kernel: 'kernel', shell: 'shell', login: 'login prompt' };

function* pins(project) {
  for (const sch of list(project.schematics)) {
    for (const pin of list(sch.pins)) yield { sch, pin };
  }
}

/** { ok, detail } for one check. `detail` says what satisfied it, or what is missing. */
export function evaluateCheck(check, project) {
  if (!project || !check) return { ok: false, detail: '' };
  switch (check.kind) {
    case 'photos': {
      const n = list(project.assets).filter((a) => !check.side || a.side === check.side).length;
      const min = check.min ?? 1;
      return { ok: n >= min, detail: `${n} of ${min}` };
    }
    case 'meta': {
      const value = String(project.meta?.[check.field] ?? '').trim();
      return { ok: value !== '', detail: value };
    }
    case 'markers': {
      const n = list(project.markers).length;
      const min = check.min ?? 1;
      return { ok: n >= min, detail: `${n} of ${min}` };
    }
    case 'pin_role': {
      const roles = list(check.roles);
      for (const { sch, pin } of pins(project)) {
        if (roles.includes(pin.role)) return { ok: true, detail: `${headerName(project, sch.id)} pin ${pin.index}` };
      }
      return { ok: false, detail: '' };
    }
    case 'reading': {
      const modes = check.mode ? list(check.mode) : null;
      const matching = new Set();
      let example = '';
      for (const { sch, pin } of pins(project)) {
        if (check.role && pin.role !== check.role) continue;
        const hit = list(pin.readings).find((r) => r && typeof r === 'object'
          && (!modes || modes.includes(r.mode))
          && (check.powered === undefined || r.powered === check.powered)
          && (check.max === undefined || (typeof r.value === 'number' && r.value <= check.max))
          && (check.min === undefined || (typeof r.value === 'number' && r.value >= check.min)));
        if (hit) {
          matching.add(`${sch.id}:${pin.index}`);
          example ||= `${headerName(project, sch.id)} pin ${pin.index}: ${hit.text ?? hit.value}`;
        }
      }
      const count = check.count ?? 1;
      return { ok: matching.size >= count, detail: matching.size >= count ? example : `${matching.size} of ${count} pins` };
    }
    case 'capture': {
      // A console session that saw all of `seen`, at least one of `seen_any`, at `baud`, with enough bytes.
      const all = list(check.seen), any = list(check.seen_any);
      const hit = list(project.captures).find((c) => {
        const seen = new Set(list(c?.seen));
        return all.every((k) => seen.has(k)) && (!any.length || any.some((k) => seen.has(k)))
          && (check.baud === undefined || c.baud === check.baud) && (c.bytes ?? 0) >= (check.min_bytes ?? 0);
      });
      if (hit) return { ok: true, detail: `${hit.baud ?? '?'} baud, saw ${list(hit.seen).map((k) => SIGN_NAMES[k] ?? k).join(', ')}` };
      const latest = list(project.captures).at(-1);
      return { ok: false, detail: latest ? `latest console capture saw ${list(latest.seen).map((k) => SIGN_NAMES[k] ?? k).join(', ') || 'nothing recognisable yet'}` : 'no console capture yet' };
    }
    case 'logic': {
      // A logic analyzer capture (kind "logic"). The service stores what it decoded and any comparison
      // with a console capture on the capture itself. With no parameters, any imported capture passes.
      const captures = list(project.captures).filter((c) => c?.kind === 'logic');
      if (!captures.length) return { ok: false, detail: 'no logic capture yet' };
      const all = list(check.seen), any = list(check.seen_any);
      const wantsCompare = check.compared === true || check.min_ratio !== undefined;
      const wantsDecode = wantsCompare || check.decoded === true || check.baud !== undefined || check.min_bytes !== undefined
        || all.length > 0 || any.length > 0;
      const percent = (ratio) => `${Math.round((ratio ?? 0) * 100)}%`;
      for (const c of captures) {
        for (const d of wantsDecode ? list(c.decoded) : [null]) {
          if (d) {
            const seen = new Set(list(d.seen));
            if (!all.every((k) => seen.has(k)) || (any.length && !any.some((k) => seen.has(k)))) continue;
            if (check.baud !== undefined && d.baud !== check.baud) continue;
            if ((d.bytes ?? 0) < (check.min_bytes ?? 0)) continue;
          }
          let ratio;
          if (wantsCompare) {
            if (!c.compare || (d && c.compare.channel !== d.channel)) continue;
            ratio = c.compare.ratio ?? 0;
            if (ratio < (check.min_ratio ?? 0)) continue;
          }
          const decoded = d ? `: ${d.name} at ${d.baud} baud, ${d.bytes} bytes` : '';
          const compared = ratio === undefined ? '' : `, ${percent(ratio)} the same as the console capture`;
          return { ok: true, detail: `${c.label || 'capture'}${decoded}${compared}` };
        }
      }
      const latest = captures.at(-1);
      const first = list(latest.decoded)[0];
      if (wantsDecode && !first) return { ok: false, detail: 'latest capture has nothing decoded yet' };
      if (wantsCompare && !latest.compare) return { ok: false, detail: 'decoded, not compared with a console capture yet' };
      if (wantsCompare && (latest.compare.ratio ?? 0) < (check.min_ratio ?? 0)) {
        return { ok: false, detail: `latest comparison is ${percent(latest.compare.ratio)} the same` };
      }
      const seenNames = list(first?.seen).map((k) => SIGN_NAMES[k] ?? k).join(', ');
      return { ok: false, detail: `latest capture decoded ${first?.name} at ${first?.baud} baud${seenNames ? `, saw ${seenNames}` : ''}` };
    }
    case 'uart_header': {
      for (const sch of list(project.schematics)) {
        const roles = new Set(list(sch.pins).map((p) => p.role));
        if (['GND', 'TX', 'RX'].every((r) => roles.has(r))) return { ok: true, detail: headerName(project, sch.id) };
      }
      return { ok: false, detail: '' };
    }
    default:
      return { ok: false, detail: `unknown check ${String(check.kind)}` };
  }
}

export const isDone = (progress) => Boolean(progress?.done);

export function playbookFinished(playbook, record) {
  return list(playbook?.steps).length > 0 && list(playbook.steps).every((s) => isDone(record?.steps?.[s.id]));
}

/** Everything the panel needs to draw one step and decide what may be done with it. */
export function stepState(playbook, stepIndex, project, mode = 'guided') {
  const step = playbook.steps[stepIndex];
  const record = project?.playbooks?.[playbook.id] ?? {};
  const progress = record.steps?.[step.id] ?? {};
  const gatesTicked = progress.gates ?? {};
  const answers = progress.answers ?? {};

  const checks = list(step.checks).map((check) => ({ check, ...evaluateCheck(check, project) }));
  const gates = list(step.gates).map((gate) => ({ gate, ticked: gatesTicked[gate.id] === true }));
  const asks = list(step.ask).map((ask) => ({ ask, value: String(answers[ask.id] ?? '') }));

  const checksOk = checks.every((c) => c.ok);
  const gatesOk = gates.every((g) => g.ticked);
  const destructiveOk = gates.every((g) => !g.gate.destructive || g.ticked);
  const asksOk = asks.every((a) => !a.ask.required || a.value.trim() !== '');
  const earlierDone = playbook.steps.slice(0, stepIndex).every((s) => isDone(record.steps?.[s.id]));
  const done = isDone(progress);
  const guided = mode !== 'expert';

  const blockers = [];
  if (guided && !earlierDone) blockers.push('Finish the earlier steps first.');
  if (guided ? !gatesOk : !destructiveOk) blockers.push(guided ? 'Confirm the safety points.' : 'Confirm the destructive-action points.');
  if (guided && !asksOk) blockers.push('Answer the questions.');
  if (guided && !checksOk) blockers.push('Some checks do not pass yet.');
  const warnings = !guided && !checksOk ? ['Some checks do not pass.'] : [];

  return {
    step, done, checks, gates, asks,
    open: !guided || earlierDone || done,
    canComplete: !done && blockers.length === 0,
    blockers, warnings,
  };
}

/** Index of the step to show first: the first one not done, or the last. */
export function currentStep(playbook, project) {
  const record = project?.playbooks?.[playbook.id] ?? {};
  const index = playbook.steps.findIndex((s) => !isDone(record.steps?.[s.id]));
  return index === -1 ? Math.max(playbook.steps.length - 1, 0) : index;
}

/** Playbooks this one requires that are not finished on this board. */
export function missingRequirements(playbook, playbooks, project) {
  return list(playbook.requires).filter((id) => {
    const other = playbooks.find((p) => p.id === id);
    return other && !playbookFinished(other, project?.playbooks?.[id]);
  });
}
