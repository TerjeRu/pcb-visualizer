// Drives the real app client against a real service. argv: baseUrl token slug. Prints JSON.
import { BoardClient } from '../../app/js/client.js';
import { listBoards } from '../../app/js/api.js';
import { entryFor, stillThere } from '../../app/js/core/undo.js';

const [baseUrl, token, slug] = process.argv.slice(2);
const boards = await listBoards({ baseUrl, token });
const client = new BoardClient({ baseUrl, token, slug, actor: 'ws' });
const live = new Promise((resolve) => client.subscribe((s) => { if (s.status === 'live') resolve(); }));
client.connect();
await live;
const change = { type: 'project/metaUpdated', patch: { notes: 'from the real client' } };
const { seq } = await client.apply(change);
const notes = client.state.project.meta.notes;
// Undo needs the board around the change at the moment the service confirms it.
const seen = await Promise.race([client.around(seq), new Promise((resolve) => setTimeout(() => resolve('late'), 0))]);
const entry = entryFor(change, seen.before, seen.after, 'Notes');
const undoSeq = (await client.apply(entry.back)).seq;
const undone = client.state.project.meta.notes;
const back = await client.around(undoSeq);
await client.apply(entryFor(entry.back, back.before, back.after, 'Notes').back);
const out = { boards, status: client.state.status, notes, undone, redone: client.state.project.meta.notes,
  stillThere: stillThere(entry, client.state.project), seq: client.state.seq };
client.close();
process.stdout.write(JSON.stringify(out));
setTimeout(() => process.exit(0), 50);
