// Drives the real app client against a real service. argv: baseUrl token slug. Prints JSON.
import { BoardClient } from '../../app/js/client.js';
import { listBoards } from '../../app/js/api.js';

const [baseUrl, token, slug] = process.argv.slice(2);
const boards = await listBoards({ baseUrl, token });
const client = new BoardClient({ baseUrl, token, slug, actor: 'ws' });
const live = new Promise((resolve) => client.subscribe((s) => { if (s.status === 'live') resolve(); }));
client.connect();
await live;
await client.apply({ type: 'project/metaUpdated', patch: { notes: 'from the real client' } });
const out = { boards, status: client.state.status, notes: client.state.project.meta.notes, seq: client.state.seq };
client.close();
process.stdout.write(JSON.stringify(out));
setTimeout(() => process.exit(0), 50);
