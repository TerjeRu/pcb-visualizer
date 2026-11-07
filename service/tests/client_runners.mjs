// Node side of the cross-language tests. Reads JSON on stdin, prints JSON.
//   mode "reduce":  { initial, events }  -> project after every event, using the app's reducer only
//   mode "replay":  { events }           -> project rebuilt from stored events (with meta.modified)
//   mode "inverse": { initial, events }  -> the app's undo of each event, built from the project before it
import { reduceProject, replay } from '../../app/js/core/apply.js';
import { inverse } from '../../app/js/core/undo.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { mode, initial, events } = JSON.parse(input);

if (mode === 'reduce') {
  let project = initial;
  const states = [];
  for (const event of events) { project = reduceProject(project, event); states.push(project); }
  process.stdout.write(JSON.stringify(states));
} else if (mode === 'inverse') {
  process.stdout.write(JSON.stringify(events.map((event, i) => inverse(event, initial[i]))));
} else if (mode === 'replay') {
  process.stdout.write(JSON.stringify(replay(events)));
} else {
  throw new Error(`unknown mode ${mode}`);
}
