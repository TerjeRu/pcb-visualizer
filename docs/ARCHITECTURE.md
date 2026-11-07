# Architecture

## Overview

```
  app/ (browser or Tauri window) ──┐
  pcbv CLI (note, measure, shell) ─┤                     ┌──> journal/events.jsonl (source of truth)
  serial and pty sessions ─────────┼──> service ─────────┼──> project.pcb.json (snapshot)
  bench assistant (approved) ──────┤    validate, append ├──> captures/, assets/
  outside edits of the snapshot ───┘    apply, broadcast └──> every connected client
```

- **The service owns the state.** `service/` (Python, FastAPI) holds one event log per board. Every
  project-state change is an event: it is checked, given the next `seq`, fsynced to `journal/events.jsonl`, applied
  by the reducer (`reducer.py`) and written to the snapshot `project.pcb.json`. Replaying the journal
  reconstructs project state. Asset/capture contents and assistant findings live in separate files.
- **Clients hold a copy.** The front end in `app/` connects over a WebSocket, receives a snapshot or the
  events it missed, and applies each event with `app/js/core/apply.js`, which mirrors the Python
  reducer (held to it by `service/tests/test_client_parity.py`). Edits go out as events and appear
  on screen when the service broadcasts them, so every window and every client sees the same order.
  A broadcast only queues the message in each window's outbox (`sender.py`) while the board lock is held;
  a separate task per window sends it. A window that stops reading fills its own outbox and is
  disconnected, and it resyncs when it reconnects; it never delays a write.
- **Outside edits are events too.** A snapshot changed by an editor or a script is detected and
  validated before being recorded as `project/replaced`. Invalid or ambiguous files are preserved in
  `.pcbv/recovery/` before a rebuild.
- **The desktop app is a shell.** `desktop/` (Tauri 2) loads the front end from the running service
  and opens native windows for detached panels. The browser stays a full fallback.
- **The data lives apart from the code.** Boards sit in a separate data folder (`~/hw` by default). `pcbv repo init` can add git
  with a commit guard and secret scan; `pcbv sync` commits, pulls and pushes.

Protocols, routes and the event list are in `docs/SERVICE.md`, the project format in
`docs/SCHEMA.md`, panels and windows in `docs/DESKTOP.md`.

## Front end (`app/`)

```
main.js           start-up: session token, controller, panels; passes the controller to the views
controller.js     what the app does (boards, edits), testable without a DOM; builds the
                  {baseUrl, token, slug} every service call carries in one place
dom.js            el, $, options, setValue and screenRows, shared by the panels
client.js         WebSocket client: resume, acknowledgements; reconnects and resyncs share one backoff
dock.js           panels in regions and windows, from core/layout.js
panelbus.js       actions between windows: acknowledgements, board and generation checks
shell.js          panel windows in the desktop app (Tauri)
*view.js          one file per panel; they render from state and send events
boardview.js      the Board panel, wired from boardstate.js (selection and zoom), photoview.js (tabs, photo menu,
                  zoom and pan, upload, drop and paste, contents list), overlay.js (markers, callouts, resize
                  handles, arrow-key moves, pointer tools), inspector.js (header and pin) and calloutform.js
popupmenu.js      one popup menu under a button, with the menu keys; the photo menu uses it
core/             pure code: apply, checks, format, layout, markdown, schema, terminal, timeline
core/tutorial/    the tutorial as data and pure functions: lessons, facts, policy, the simulated bench (meter, wiring)
                  and consolefacts (what the Console showed, derived from text the board sent)
tutorialcontrol.js  the tutorial's controller; tutorialview.js  its coach panel
```

Views never write state directly. They call the controller, which sends an event; the new state
arrives from the service and the views render it.

While the tutorial runs, the controller's `send` (and the details form, which applies its own event) asks
`policy.allowed(step, event, project)` first, so one function decides which board changes go through; a refused
change is not sent. Actions that are not events (opening a port, starting the virtual board, an upload, an
export, the meter's buttons and the adapter wiring) ask `policy.allowedAction(step, name)` at the controller methods that do them. Locking the screen is the
HTML `inert` attribute on the top bar and a fixed layout from `core/layout.js` (`tutorialLayout`) that puts every
panel the step does not need away.

## Service (`service/src/pcbv/`)

```
server/             HTTP and WebSocket service, loopback only
  __init__.py       create_app: builds the shared state, adds the checks, includes the routers
  guard.py          Host, Origin and token checks on every request; static file headers
  state.py          AppState (open boards, consoles, budgets) and submit/broadcast for board changes
  body.py, errors.py  request body limits and reading; the {error, message} shape and its handlers
  wsauth.py         the opening step of both WebSockets
  boards.py         boards, events and the board WebSocket; files.py photos, files and export
  serial.py, terminal.py, logic.py  consoles, shell captures and the Terminal panel, logic captures
  assistant.py, settings.py, session.py, wiki.py  assistant, settings and workspaces, session codes, wiki and playbooks
captures.py         new capture ids and paths, capture lookup, the capture/stopped patch
net.py              loopback host names for the service, the CLI and model endpoints
sender.py           the bounded outbox and sending task of each board WebSocket
board.py            a board folder: journal, snapshot, single-writer lock, outside-edit detection
journal.py          the append-only event log
events.py           event validation
reducer.py          the pure reducer that turns events into the project
schema.py           project file constants and helpers
boards.py           the boards root: slugs, confinement, listing
serialmgr.py        serial consoles, one session per port, captured to the board folder
terminal.py         Terminal panel sessions on a pty
logic.py            sigrok captures: read, write, UART decode
photos.py, vision.py  photo uploads and the views the assistant sees
assistant/          the bench assistant: loop.py (a question's turns and tool calls), client.py (HTTP to the model),
                    proposals.py (command cards, label and pin suggestions, their events), settings.py (profiles,
                    usage, key stores), errors.py; assistant_tools.py holds the tools and their one-line summaries
playbooks.py, wiki.py  built-in and data-repo playbooks and wiki pages
export.py, redact.py  exports and redacted copies
datarepo.py         the data repo: template, commit guard, sync
settings.py, workspaces.py, runtime.py  per-machine settings, layouts, the service advertisement
cli.py              the pcbv command line; edits.py, shell.py, kwin.py behind its commands
vdev.py, fakemodel.py, demo.py  the virtual board, the simulated model server, the demo board
tutorial.py         the tutorial's practice board (created and rebuilt through routes, kept outside the boards root)
```

## Desktop shell (`desktop/`)

```
src-tauri/src/main.rs   finds or starts the service and opens the main window
../app/js/main.js       opens native panel windows through the Tauri API
src-tauri/src/guard.rs  what the checked service's pages may do in the shell, and where windows may go
ui/index.html           the splash page shown while the service starts
```

Persistence uses storage version 2 and client protocol 2. The journal fsync is the commit point;
snapshot failures report maintenance warnings without undoing committed state or deleting its assets.
Unverified rollback freezes writes until explicit reopen. Atomic batches stage every child and commit
one journal record. Label and pin approval receipts live in that record; ordinary mutations require
manual inspection after an uncertain response. `docs/SERVICE.md` describes recovery and retry limits.
`fsutil.py` anchors board file operations to directory descriptors and refuses relative symlinks.
