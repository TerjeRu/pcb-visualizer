# Service (`service/`)

The local Python service owns each board's state. The app, the CLI and the bench assistant are clients of it. Python 3.12 or newer, managed by `uv`, FastAPI for HTTP and WebSocket, no database.

```
cd service && uv sync          # once
npm run service                # same as: cd service && uv run pcbv serve
npm run test:service           # pytest
```

## Board folder

```
<boards root>/<slug>/
  project.pcb.json          snapshot of the current state (format in docs/SCHEMA.md)
  assets/                   photos
  journal/events.jsonl      append-only event log, the source of truth
  .pcbv/lock                held while a process has the board open for writing
  .pcbv/snapshot.sha256     hash of the last snapshot the service wrote (rebuildable cache)
```

The boards root is `--root`, else `$PCBV_BOARDS_ROOT`, else `~/hw/boards`. A board is addressed by its slug (`[a-z0-9][a-z0-9_-]{0,63}`), which is checked and resolved so it cannot leave the root, symlinks included.

## Events

One JSON object per line:

```json
{"journalVersion": 2, "seq": 3, "ts": "2026-10-25T16:02:11.482Z", "actor": "web", "type": "marker/added", "marker": {...}, "schematic": {...}}
```

`seq` counts 1, 2, 3 with no gaps. `ts` and `actor` are set by the service, never by the client. `meta.modified` is derived from the event time, so replaying a journal always reproduces the same bytes.

| Type | Payload | From clients |
|---|---|---|
| `project/created` | `project` | no, first event of every journal |
| `project/replaced` | `project` | no, written when the file was edited outside the service |
| `project/metaUpdated` | `patch` (cannot touch `id` or `created`) | yes |
| `asset/added` `asset/updated` `asset/removed` | `asset` or `id`, `patch` | yes |
| `marker/added` `marker/updated` `marker/removed` | `marker`, optional `schematic`, or `id`, `patch` | yes |
| `schematic/updated` | `id`, `patch` | yes |
| `board/batch` | `events` (1 to 256 ordinary payloads) | yes, atomic group |
| `pin/readingAdded` | `schematicId`, `index`, `reading` | yes, append one reading |
| `pin/updated` | `schematicId`, `index`, `patch` or `null` | yes |
| `components/replaced` | `components` | yes |

The front end applies the same events with `app/js/core/apply.js`, a port of `service/src/pcbv/reducer.py`. `tests/test_client_parity.py` runs both over one script and over real journals and compares the full project after every step. If you change either reducer, that test tells you whether they still agree.

An event is rejected, and nothing is written, when it is malformed (HTTP 422), when it references things that do not exist or duplicates an id (409), when an asset path is not a plain relative path under `assets/`, when a patch tries to change an `id`, or when it exceeds 1 MB.

## Durability and recovery

The journal is authoritative. Each record uses `journalVersion: 2`; snapshots use `schemaVersion: 2`.
Readers accept exactly these versions. Older, unversioned and future boards are refused before
repair, snapshot replacement or lock-file creation. These are disposable development boards: recreate
them with `pcbv new` or `pcbv demo` in a new folder. Nothing deletes existing test boards automatically.
There is no migration, and downgrading the service is unsupported.

A mutation stages and validates its state before appending. The service writes the entire encoded
record, completing short writes, then fsyncs the journal. That successful fsync is the commit point.
The state and sequence change before snapshot maintenance or notifications. The record, including its
envelope and newline, is limited to 1,000,000 UTF-8 bytes. A `board/batch` is one record and sequence;
all its children validate against staged state before any is committed. Nested batches, per-child
envelopes, creation and replacement inside a batch are refused.

A failed append is truncated to its original offset and fsynced. A verified durable rollback returns
503 `not_committed`; another user attempt is allowed. If rollback cannot be verified, the service
returns 503 `commit_unknown` and freezes board mutations. Reads show the last known state with
`storage.writable: false`. Further mutations return 503 `recovery_required`. Reopening the storage
under its writer lock resolves the outcome. In the app, restart the service to reopen cached boards.
If recovery still cannot establish durability, the board remains unavailable for writing. First open
without a usable validated state returns 503 `recovery_required`. A WebSocket receives the recovery
message before closing with 1011; the app waits for an explicit reopen and displays the instructions,
including recreation guidance for unsupported development boards.

On reopen, a complete, validated, newline-terminated record is committed after the recovered journal
is fsynced. A final suffix without a newline is discarded, even if its JSON parses. Invalid complete
records, sequence gaps and unsupported versions fail closed without rewriting the journal. These
rules assume the filesystem honours fsync; they cannot repair storage hardware that loses acknowledged
writes or silently corrupts bytes.

A snapshot or hash failure after commit returns success with `warnings: ["snapshot_dirty"]`.
The journal event and its assets remain saved. The service retries snapshot maintenance at the next
mutation or reopen, without a background retry loop. A successful rebuild clears the warning.
A snapshot matching an earlier journal state is stale and can be rebuilt even if its hash is missing.

Live outside edits are validated item by item, including references, before being recorded separately
as `project/replaced`. A rejected request can therefore still have a preceding external-edit event.
Invalid edits, corrupt snapshots and ambiguous files found on reopen are preserved before replacement
at `.pcbv/recovery/snapshot-<sha256>.json`. A byte-identical existing copy is reused. A conflicting entry
or failed preservation leaves the snapshot untouched and returns `recovery_required`.

Preservation adds `external_edit_preserved` to warnings and
`warningDetails.external_edit_preserved.path` to success responses and snapshot storage status.
The app displays this path as text. The notice remains for that open session; reopening can clear the
notice but never removes the saved copy. Recovery files need manual inspection and removal.

Immutable photos, imported captures and decoded text use exclusive creation and are synced before
their events. Cleanup removes only files owned by a known rejected or durably rolled-back operation.
Committed and uncertain writes retain their files. Interrupted operations can leave unreferenced
files; there is no automatic garbage collection. This covers metadata and immutable assets, not live
capture bytes or hardware effects. Board operations use directory descriptors and reject symlinks
in every relative component. Atomic replacement uses exclusive random temporary files, file fsync,
rename and directory fsync; failures distinguish replacement from uncertain post-replacement durability.

Ordinary mutations have no durable request receipts or automatic resend. After a lost response,
timeout or disconnect, resync and inspect the board before another attempt. The app shows:
"The operation may have completed. Refresh and inspect the board before trying again."
This applies to creation, uploads and logic imports too. WebSocket request IDs correlate replies only.

Label and pin approvals have one narrower durable receipt: the batch envelope carries a service-owned
`proposalId` of at most 128 UTF-8 bytes. Approval checks the journal under the board lock before the
pending cache. First acceptance returns `{ok: true, seq, alreadyAccepted: false}`; a repeat returns the
same sequence with `alreadyAccepted: true`, including after restart or cache loss. A missing proposal
without a committed receipt returns 404 `proposal_not_found`. Proposal IDs use 128 random bits.
Hardware commands do not use these receipts and are never automatically resent.

## HTTP

All routes need `Authorization: Bearer <token>` except `/api/health` and `POST /api/session`, which redeems a
one-time code (see Security). Host and Origin are checked on those two as well.
Every HTTP board mutation, including creation, uploads, assistant approval and serial routes, also
needs `X-PCBV-Protocol: 2`. A missing or different value returns 409 `protocol_incompatible` after
authentication and before board access. The app checks health on startup and asks for a reload on a
protocol mismatch. Both WebSocket endpoints require numeric `protocol: 2` in their auth message;
a mismatch receives an error then close 4409, without reconnecting.

Successful board mutations retain their fields and add `warnings`, plus `warningDetails` when a copy
was preserved. Board snapshots include `storage: {writable, warnings, warningDetails?}`. The app shows
persistent warnings and disables mutation controls when writable is false.

| Route | |
|---|---|
| `GET /api/health` | `{ok, version, protocol: 2}` |
| `GET /api/boards` | `{boards: [slug]}` |
| `POST /api/boards` `{name}` | create, 201 `{slug, seq}`, 409 if the folder exists |
| `POST /api/tutorial/board` | the tutorial's practice board: create it if it is missing, 201 `{slug: "pcbv-tutorial"}` either way. Needs the token like every route; see Practice board below |
| `POST /api/tutorial/board/reset` | delete the practice board and build it again, 201 `{slug}`. 409 `session_open` while a serial or terminal session is open on it |
| `GET /api/boards/{slug}` | `{seq, project, warnings, storage}` |
| `GET /api/boards/{slug}/events?since=N` | events after `seq` N |
| `POST /api/boards/{slug}/events` `{event, actor?}` | apply, 201 `{event}`; `actor` is `web`, `cli`, `http` (default) or `ws`, anything else is 422 |
| `POST /api/boards/{slug}/assets?side=&label=` raw image body | add a photo (up to 40 MB), 201 `{event}` with the `asset/added` it recorded |
| `GET /api/boards/{slug}/files/{path}` | a file under `assets/`, for the app's photo view |
| `GET /api/boards/{slug}/commits` | `{commits: [{hash, date, subject}]}` for the board folder, newest first, empty outside a git repo and while `git` is `off` |
| `GET /api/serial/ports` | `{ports, bauds, sessions}`: USB serial adapters and the `pcbv vdev` board |
| `GET /api/vdev` | `{running, owned, path}`: running means the `ttyPCBV0` link is a live symlink; `owned` means this service started it |
| `POST /api/vdev/start` | start the virtual board and wait up to 5 seconds for its link; 200 with `owned: false` and nothing started when one runs already; 500 `vdev_failed` with the child's first stderr lines when it does not appear |
| `POST /api/vdev/stop` | stop a board this service started; 409 `vdev_not_owned` for one started elsewhere |
| `POST /api/boards/{slug}/serial` `{port, baud}` | open a console for this board, 201 `{state}` |
| `POST /api/boards/{slug}/serial/close` | close it |
| `POST /api/boards/{slug}/serial/detect` `{port, seconds?}` | listen at 115200, 57600, 38400, 19200, 9600 and 230400 (`seconds` each, 0.5 to 3, default 1.5) and rank by readable output; `best` is set when one scores at least 85% |
| `POST /api/boards/{slug}/shell` `{label}` | start a shell capture for `pcbv shell`, 201 `{capture}` with the path to write |
| `POST /api/boards/{slug}/shell/{id}/stop` `{reason?}` | read the transcript, recognise what it can, record `capture/stopped`; reason is `closed` or `recording error` |
| `POST /api/boards/{slug}/serial/write` `{sessionId, line, confirm?}` or `{sessionId, key}` | send a line plus Enter, or one of `enter`, `space`, `ctrl-c`, `ctrl-d`; 409 `confirm_required` for known destructive lines |
| `GET /api/bench-check` | `{checks: [{id, ok, label, fix}]}` for `serial-group` (the running session is in the group that owns the first of `/dev/ttyUSB*`, `/dev/ttyACM*` and `/dev/ttyS0`, a root-owned device skipped; with none, `dialout` if that group exists, else `uucp`), `sigrok` (`sigrok-cli` on the path), `fx2lafw` (an `fx2lafw-*.fw` file in `/usr/share/sigrok-firmware` or `/usr/local/share/sigrok-firmware`) and `gitleaks` (the gitleaks probe below answers ok), in that order. It changes nothing. `fix` is what to show when `ok` is false: the install command for the distribution family in `/etc/os-release` (`pacman`, `apt` or `dnf`), or "Install ... with your package manager." for another family. For gitleaks on the Debian family it is the gitleaks release page, because Debian 13 and Ubuntu 24.04 package 8.16 |
| `GET /api/settings` / `POST /api/settings` `{guidance?, theme?, assistant?, git?, welcomed?, tutorial?, tutorialStep?}` | app settings in `~/.config/pcbv/settings.json`; `guidance` is `guided` or `expert`, `theme` is `system`, `light` or `dark`, `assistant` and `git` are `off` or `on` and start `off`, `welcomed` is a bool that starts `false` and ends the first-start Welcome (anything but `true` or `false` is 422). `tutorial` is `new` (the default), `skipped`, `started` or `done`, and `tutorialStep` (a whole number from 1 to 18, default 1) is where a started tutorial resumes; anything else is 422. A file without `tutorial` gets `skipped` when `welcomed` is `true` (an existing user is not offered the tutorial on their own; Settings still starts it), else `new`. `GET` also answers `data_folder`, the parent of the boards folder; it is not a setting and `POST` refuses it. A file that lacks `assistant`, `git` or `welcomed` gets them once on the next read and is written back; `welcomed` is `true` when the boards folder already holds a board, so an existing install never sees the Welcome: `assistant` is `on` when `assistant.json` exists, `git` is `on` when the data folder (the parent of the boards folder) is a git repository whose `core.hooksPath` is `.githooks`. `git` is acted on: while it is `off` the commits route answers an empty list, the assistant's timeline tool sees no commits and `pcbv sync` refuses (exit 1). Turning `git` on is refused with 422 `git_not_ready` (the message lists what is missing) until the local checks of `GET /api/git` pass; turning it off, or changing another setting while it is on, is never held back, and neither deletes data or repository files. `assistant` is acted on: see `assistant_off` below. A change is pushed to every open board socket as `{"op":"settings","settings":{...}}` |
| `GET /api/workspaces` / `POST /api/workspaces` `{current, saved}` | named panel layouts in `~/.config/pcbv/workspaces.json` (see `docs/DESKTOP.md`) |
| `WebSocket /api/boards/{slug}/terminal` | Terminal panel: `{op: auth, protocol: 2, token, cols, rows}`, then `input` / `resize`; server sends `started`, `output`, `exit`. Output the window cannot keep up with is dropped, oldest first, with one notice line (see Limits). Input the program does not read is held up to the input limit in Limits; each `input` message is cut to 64,000 bytes at a character boundary |
| `GET /api/wiki` | `{pages: [{name, title, origin, section}]}` in index order: built-in starter pages plus `~/hw/wiki/*.md` (same name replaces) |
| `GET /api/wiki/figures/{file}` | a figure (`.svg`, `.png`) from `~/hw/wiki/` or the built-in pages, with a script-blocking CSP |
| `GET /api/wiki/{name}` | `{name, title, origin, markdown}`, or 404 with the path to create |
| `POST /api/boards/{slug}/logic?name=&samplerate=` raw body | import a sigrok `.sr` or CSV logic capture, 201 `{capture}`; 429 `work_busy` when two imports or decodes are already running (see Limits). A channel whose speed cannot be decoded at the capture's sample rate is left out of `decoded` |
| `GET /api/boards/{slug}/logic/{id}/edges?start=&end=&bins=` | level changes for a window, or a per-column summary |
| `POST /api/boards/{slug}/logic/{id}/decode` `{channel, baud?}` | decode UART 8N1, stored on the capture |
| `POST /api/boards/{slug}/logic/{id}/compare` `{channel, with}` | compare decoded text with a console capture |
| every route below with `assistant` in its path | While `assistant` is `off` each one answers 409 `assistant_off` (after the token check, before the body is read), so no model call, key or conversation can be reached. The check is a dependency of the whole router, so a new assistant route has it too (`test_every_assistant_route_refuses_with_409_while_the_assistant_is_off` walks the route table). Turning it off also stops a question that is already running: the loop asks the setting before each model call and each tool call, so no further tool runs and the question ends with the same 409. Conversations, stored keys, profiles and findings already written are kept |
| `GET /api/git` | `{ok, detail}` for the data folder (the parent of the boards folder). `ok` is true when every local check passes: `git` and `gitleaks` installed, the folder is a repository, the commit guard is active, and photo originals are git-ignored. `detail` has `setting`, `folder`, `git`, `gitleaks`, `repository`, `guard`, `originals_ignored` (null before the repository exists), `remote` (the `origin` address with any credentials replaced by `***`), `last_commit` (ISO time) and `problems` (one line each) |
| `POST /api/git/setup` `{step, url?, replace?}` | Runs one setup step and answers `{ok, detail}`; a step that cannot finish answers 200 with `ok` false and the reason. The body is limited to 4 KiB. Every call looks at the folder again. `check`: `git` is on PATH and the gitleaks probe answers ok, else one line each with the fix for the distribution family (as in the bench check). `init`: `init_repo` on the data folder, listing what it created; repeating it is harmless. `ignore`: `git check-ignore` on a photo original path under `<boards folder>/<slug>/assets/photos/originals/`; refuses with the EXIF/GPS reason when it is not ignored. `remote`: optional `url`, at most 2 KiB, either the SSH form `git@host:owner/repo.git` or `https://` without a user name or password; other schemes, control characters, spaces and a leading dash are 422 `invalid_git_setup`. An existing different `origin` is replaced only with `replace: true`, otherwise the answer is `ok` false with `confirm: {old, new}`; that question comes before any request outside the service. For an address on GitHub (both forms; `github.com`, `www.github.com` or `ssh.github.com`, any case, a trailing dot ignored, https on the default port; the owner and repository must be plain names) it first sends one unauthenticated `GET https://api.github.com/repos/<owner>/<repo>` with a 10 second limit and no token, and nothing else leaves the machine. 200 means public: the step answers `ok` false and sets nothing. 404 means private or not created yet and the step goes on. Anything else, including a network error, answers `ok` false with "Could not check whether the repository is private" and never counts as private. Another host is not checked and the answer says so. The step then adds or replaces `origin` and runs `git ls-remote` on the address with a 20 second limit, no terminal and `ssh -o BatchMode=yes`, so it never waits for a password; an empty repository passes. A failure answers `ok` false with git's last line and one hint (log in with `gh auth login`, add the SSH key, accept the host key with `ssh -T git@github.com`, or check the address); `origin` stays set so the step can be run again after the login is fixed. The check runs again each time the step runs, also when `origin` is already that address. `sync`: one sync of the data folder, which pushes when `origin` exists; before any pull or push it runs the same private check on every address git pushes to (see `pcbv sync`), so a repository made public later, or an `origin` set outside the app, is not pushed to. A stray field or unknown step is 422 `invalid_git_setup`. Steps run one at a time for the whole service; a request meanwhile gets 409 `git_busy`. Each git command has a 60 second deadline (the access check 20) and runs with no terminal and no password window (`GIT_TERMINAL_PROMPT=0`, an empty `GIT_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, so Plasma's `ksshaskpass` does not open), so a missing credential fails at once; there is no automatic retry. Errors and addresses shown hide credentials. The steps run while `git` is `off`; setup never turns it on. The `ok` and `detail` of a failed sync say that the local commit was kept |
| `GET /api/assistant` | `{default, profiles, usage, keyring, settings_warnings}`; `keyring` is `{available, detail}` and is checked with a harmless read, so a locked wallet counts as unavailable; profiles show `key_set`, never the key. Each profile in `assistant.json` is checked on its own: one that fails keeps its default values and is listed in `settings_warnings` as `{profile, message}`, the others are kept, and a read never rewrites the file. A file that cannot be read or is not an object, or whose `profiles` is not an object, lists every profile. Saving settings then writes the reset profiles' defaults and deletes their stored keys, because the address each key belonged to is gone |
| `POST /api/assistant/settings` `{default?, profiles?}` | server address, model, prices, `photos` and `budget` per profile (`tutor`, `analyst`, `local`), and `name` for the two cloud slots `tutor` and `analyst` (1 to 24 characters, trimmed, no control characters; defaults Quick and Thorough; refused for `local`, which the app always calls Local; a missing name keeps the earlier one), saved in `~/.config/pcbv/assistant.json`. An address must be `https://`, unless its host is `localhost`, `127.0.0.1` or `::1`. Answers the view plus `keys_cleared`: the profiles whose stored key was deleted because their scheme, host or port changed (a change of path keeps the key). `budget` is `normal` (up to 8 model calls with tools per question, then one without, replies up to 8000 tokens) or `deep` (24 calls, 16000 tokens); a missing value keeps the earlier one and reads as `normal`, an address change keeps it, any other value is 422. Commands still need the person's approval in both |
| `POST /api/assistant/test/{profile}` | one chat request ("Reply with the word ok.", with the tool descriptions and `tool_choice` `none`, no board data, no photos, at most 16 reply tokens) to the profile's saved address, key and model. Answers `{ok: true, model, totals, note}` (totals: the profile's usage line, as after a question; `note` is empty, or says a thinking model used the short reply on thinking) or `{ok: false, message}` with a plain reason (key refused, unknown model name, model cannot use tools, model wrote nothing, server not reachable, timeout, missing address or model). It counts in the usage totals. 409 `assistant_off` while the assistant is off; 422 for an unknown profile |
| `POST /api/assistant/keys/{profile}` `{key}` | store (or `null` to remove) the API key in the system keyring; 503 `keyring_unavailable` without one |
| `POST /api/boards/{slug}/assistant/chat` `{message, profile?, conversation?, context?}` | one question; tools can read board context, append findings and create proposals; returns `{reply, tools, proposals, usage, totals}`; 502 `model_server` on upstream trouble; 429 `assistant_busy` when two questions are already being answered or this conversation is still answering |
| `GET /api/boards/{slug}/assistant/conversation` | `{messages: [{role, text}]}`: the questions and answers the service still holds (memory only, trimmed like the model's history), so a reloaded panel can show them |
| `POST /api/boards/{slug}/assistant/reset` | forget the conversation |
| `GET /api/boards/{slug}/assistant/proposals` | what the assistant suggested, by `kind`: `command`, `label` or `pins`; status `pending`, `refused`, `sent`, `accepted`, `declined` or `failed` |
| `POST /api/boards/{slug}/assistant/proposals/{id}` `{action: approve\|decline, sessionId?}` | only a person can do this; 404 `proposal_not_found` for an unknown id. Approving a command needs `sessionId`, the open console's `captureId` (422 without it, 409 `session_stale` when that console has changed or closed); the command is typed into that console after checking the destructive-command guard again, and the answer is `{proposal}`. A label or pin roles are written to the board as unverified guesses and answer `{ok, seq, alreadyAccepted}` (409 if the board changed so they no longer fit). Declining answers `{proposal}` |
| `POST /api/session/code` (empty JSON body) | a one-time login code for opening another window: `{code, expiresIn: 60}`. Needs the token; 429 `session_busy` when 128 unused codes are alive |
| `POST /api/session` `{code}` (body at most 1 KiB) | exchanges a live code, once, for `{token}`; 401 `invalid_code` for a wrong, expired or used code. The one call without a token |
| `GET /api/playbooks` | `{playbooks, problems}`: built-in and data repo playbooks, read from disk on each call (format in `docs/PLAYBOOKS.md`) |

Photo uploads accept JPEG, PNG and WebP. The service checks the image (with a pixel limit against decompression bombs), keeps the original at `assets/photos/originals/<id>.<ext>`, and writes an upright copy of at most 2560 px on its long side, JPEG, without EXIF (so no GPS position), at `assets/photos/<id>.jpg`. The asset points at the copy and records its size, so markers are in the copy's pixels; `original` records where the original is. The data repo ignores `originals/`. Files need the token like every other route, so the app fetches them and shows them as blob URLs.

Every error is `{error, message}`: 400 bad name or bad request, 401, 403 host or origin, 404 `not_found` (also an unknown route), 405, 409 conflict or exists, 413 `too_large`, 422 (`invalid_event`, `invalid_photo`, `invalid_capture`, `bad_request` for a malformed query or field), 423 board open in another process, 429 `work_busy`, 500 `internal_error`, 503 not_committed, commit_unknown or recovery_required for storage failures, including an unusable journal on first open.

## Limits

### Practice board

The tutorial works on a real board, kept apart from the user's own: the folder `$XDG_DATA_HOME/pcbv/practice/pcbv-tutorial`
(default `~/.local/share/pcbv/practice/pcbv-tutorial`), which is not under the boards root. The slug `pcbv-tutorial` is
reserved: `board_path` refuses it for the boards root, creating a board whose name makes that slug answers 400
`bad_name` "That name is reserved.", and the registry resolves that slug, and only that slug, through
`boards.practice_path()`, with the same no-follow rules as the boards root (a symlink in place of the board folder
or of the practice folder is refused). `GET /api/boards` never lists it, and the data repository, `pcbv sync` and the
git setup never see it. The board is the synthetic router's front photo and the practice logic capture, with no
markers, callouts or playbook progress (`tutorial.py`). Reset removes the folder with `Directory.remove_tree`, which
deletes a symlink inside it as a link and never follows it, then builds the board again.

These are fixed limits, in binary units where a unit is named. They are not settings.

| What | Limit | Over the limit |
|---|---|---|
| JSON request body | 2,000,000 bytes | 413 `too_large` |
| Photo upload | 40,000,000 bytes | 413 `too_large` |
| Logic capture upload | 250,000,000 bytes | 413 `too_large` |
| Request bodies being read at once, all routes together | 400 MiB | 429 `work_busy` |
| Logic imports, decodes and capture loads running at once | 2, with no waiting line; two imports also share the upload budget above, so two uploads near the 250,000,000-byte limit do not fit at once | 429 `work_busy` |
| A capture after decompression (`.sr` or CSV) | 200,000,000 samples; the `.sr` metadata file 64 KB | 422 `invalid_capture` |
| Logic samples kept in memory | 400 MiB and 2 captures; the least recently used leaves first and is read from the board again when needed | |
| A picture | 100 million pixels, read from the file header before any pixel is decoded | 422 `invalid_photo` |
| Photos prepared for the assistant | 64 MiB of decoded pixels, each photo kept at no more than 4096 px on its long side | |
| Reply from a model server | 4 MiB, counted as it arrives; 10 s to connect, 60 s for each wait on the socket | 502 `model_server` |
| Questions answered at once | 2, and one per board and conversation | 429 `assistant_busy` |
| Unused login codes | 128, each valid 60 s | 429 `session_busy` |
| Terminal output between the shell and the window | 256 items and 1 MiB | the oldest output is dropped and one line in the window says so |
| Terminal input waiting for the shell | 256 KiB | the paste is refused and one line in the window says so |
| Board socket outbox, per window | 256 queued messages and 8 MiB of encoded JSON; each send must finish within 5 s | the window is closed with 4408 `slow-client` and reconnects (see WebSocket) |
| One board socket message (snapshot, event) | 8 MiB | `board_too_large` error, then close 4408 `board-too-large`; the window does not reconnect |

Bodies are counted as they arrive, so a chunked request with no `Content-Length` meets the same limits.
A request is authenticated before its body is looked at, and a board socket before the board is opened.
The upload budget counts the bodies being read; parsing makes copies, so the limits above do not add up
to a bound on the whole process. Measured on 2026-10-29 with a scratch service that started at 54 MiB: a
4 MiB file that expands to 4 GiB was refused after the process peaked at 258 MiB, and five imports in a row
of a 200,000,000-sample capture peaked at 840 MiB. Two at once of 100,000,000 samples, plus a third that
got 429, peaked at 756 MiB. While a terminal window stopped reading and the shell wrote output without end,
the service stayed at 56 MiB.

Client actors are `web`, `cli`, `http` and `ws`. The service keeps `service`, `external` and `assistant` for
its own events, so a client cannot write an event as one of them.

## WebSocket `/api/boards/{slug}/ws`

1. Client sends `{"op":"auth","protocol":2,"token":...,"actor":"web","sinceSeq":N}` within 5 seconds. Anything else closes with code 4401. An `actor` that is not one of the four client actors gets an `error` and code 4400.
2. If `sinceSeq` is an integer in `0..seq`, the server sends `{"op":"ready","mode":"resume","seq":S,"storage":{...}}` then every event after N. Otherwise it sends `{"op":"snapshot","seq":S,"project":{...},"recent":[...],"storage":{...}}`, where `recent` is up to the last 50 events, for the change feed. The client is added to the live stream in the same step, so nothing is missed or sent twice.
3. Server pushes `{"op":"event","event":{...}}` for every applied event, in the same order for every client. An outside edit found on the way arrives as its own `project/replaced` event first.
4. Client sends `{"op":"apply","id":"c1","event":{...}}` and gets `{"op":"ack","id":"c1","seq":N,"warnings":[],"storage":{...}}` or `{"op":"error","id":"c1","code":"invalid_event"|"conflict","message":...}`. `{"op":"ping"}` returns `pong`.
5. Messages that are not project state arrive on the same socket: `serial` and `serial-data` for the console, `settings` when the app settings change in any window.

A client that reconnects with its last seen `seq` gets exactly the events it missed.

Each socket has one outbox and one sending task. Catch-up, snapshot, events, replies (`pong`, `ack`, `error`) and console output all go through it in the order they were queued, so a reply never overtakes an event committed before it, and a window that stops reading cannot hold up writes to the board or the other windows. The outbox holds 256 messages and 8 MiB (see Limits) and each send has 5 seconds to finish. A window that passes either limit or misses the deadline is closed with code 4408 and reason `slow-client`; the app reconnects with its usual backoff and resumes from its last `seq`. When a catch-up would fill more than half of the outbox, the service sends a snapshot instead of a resume, so a window that was away for long does not fail the same way again. A single message larger than 8 MiB, which in practice means a snapshot of a very large board, gets `{"op":"error","code":"board_too_large"}` and then close 4408 with reason `board-too-large`; the app shows the error and does not reconnect.

## Security

Loopback only (`pcbv serve` refuses other hosts). The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (DNS rebinding). `Origin`, when present, must be a loopback web origin or the Tauri shell. A per-session random token is required, compared in constant time, and advertised in `$XDG_RUNTIME_DIR/pcbv/service.json` with mode 0600 (fallback: `~/.cache/pcbv/service.json` when `XDG_RUNTIME_DIR` is unset; that folder has mode 0700 but is an ordinary folder, so the token can stay on disk after a crash). Windows do not get that token: `pcbv open` and the desktop shell read it, ask `POST /api/session/code` for a code, and open the page with `#code=...`. A code is 32 random bytes (base64url), lives 60 seconds in the service's memory and is removed when redeemed; the page exchanges it at `POST /api/session` and keeps the token in `sessionStorage`. During its minute the code is a credential: it keeps the token out of launch arguments and history but does not stop another process running as you. A panel window opened from the main window gets a code of its own; if its storage loses the token on reload, it asks the window that opened it (same origin, 5 seconds) and otherwise tells the person to reopen it or run `pcbv open`. The advertised address brackets an IPv6 host, as in `http://[::1]:8766`. One process at a time can write a board (`flock`), so the CLI and the service cannot race on a journal.

## CLI

```
pcbv new "Nimbus N100"       create a board folder
pcbv demo                        create the demo board (demo.py): drawn photo, headers, callouts, captures. Only the command line makes it; the app no longer has a route or button for it
pcbv status [board] [--json]     read-only; safe while the service is running
pcbv serve [--port 8765]         run the service
pcbv redact board [--out DIR] [--check] [--include-logic] [--no-photos]
                                 write a redacted copy of a board for sharing
pcbv export board [--out DIR] [--format photo,svg,report,csv,json,zip] [--no-redact]
                                 export a board for sharing (see Export)
```

The other commands (`open`, `note`, `measure`, `shell`, `repo`, `sync`, `agents-md`, `kwin-rules`,
`vdev`, `fake-capture`, `fake-model`) are covered in the sections below, in `docs/DESKTOP.md` and in the README;
`pcbv <command> --help` lists the options.

`status` reports the service as running only when its `/api/health` answers, since a crash can leave the advertisement file behind and its process id can be reused. `serve` refuses to start while another service answers, and removes the advertisement on exit, including after SIGTERM.

`PCBV_STOP_WITH_PID` (set by the desktop shell, see `docs/DESKTOP.md`) names a process the service ends with. `serve` opens a pidfd for it (`os.pidfd_open`, Linux 5.3 or later) and, when that process ends for any reason, sends itself SIGTERM, which takes the normal shutdown path above. The value must be a decimal process id from 2 to 4194304 (`pcbv: PCBV_STOP_WITH_PID must be a process id`, exit status 2), and the process must exist (`pcbv: the app that started this service has already quit`, exit status 1); both are checked before the socket is bound. Unset or empty means no watcher.

## Redaction (`pcbv redact`)

`redact.py` writes a copy of a board with sensitive values replaced; the board itself is never changed. Text files are redacted line by line, `.json` and `.jsonl` files value by value (a text replacement could cut through an escaped quote), and the copy reports each replacement by kind, file and line in `REDACTION.md`, never the value itself.

| Replaced | Rule | Stand-in |
|---|---|---|
| Credentials | the data repo's gitleaks `router-credential` rule, plus OpenWrt `option key '...'` lines; masked values (`****`, `<...>`) stay | `[SECRET-n]` |
| Password hashes | crypt(3) `$1$`, `$5$`, `$6$`, `$2*$`, yescrypt `$y$`, `$sha1$`, and 13-character DES crypt in the second field of a shadow-style line (`user:hash:days:`) | `[PASSWORD-HASH-n]` |
| Private keys and certificates | whole PEM blocks, `-----BEGIN X-----` to the matching `-----END X-----`, across lines; a header without its end line is replaced together with the base64 lines (16 or more characters each) right under it, and a header with no such line stays | `[PEM-BLOCK-n]` |
| JSON values under secret keys | in `.json` and `.jsonl` files, every string or number below a key with the segment `password`, `passwd`, `secret`, `token`, `key`, `psk` or `wpa` (`wifiPassword`, `api_key`; `keyboard` and `keys` do not match). Empty and masked values stay | `[SECRET-n]` |
| Serial numbers | `serial`, `serial_no`, `S/N`, `SN` followed by `=` or `:`; TR-069 `<SerialNumber>` | `[SERIAL-n]` |
| Your strings | `.pcbv/redact.txt` in the board folder, one per line (ignored by the data repo's git) | `[CUSTOM-n]` |
| Email addresses | | `userN@example.invalid` |
| MAC addresses | colon, dash and dotted forms; all-zero and broadcast stay | `02:00:00:00:00:0n`, locally administered |
| Public IP addresses | IPv4 and IPv6 that `ipaddress` calls global; private, link-local and loopback stay, and so do dotted numbers after the whole words "version", "ver", "v", "kernel" or "Linux" (so "server 81.166.12.34" is replaced) | RFC 5737 and RFC 3849 documentation ranges |

The same value always gets the same stand-in within one copy. Photos are turned upright from their EXIF orientation and re-encoded without EXIF, XMP or ICC data and listed under "Check by eye", since printed labels cannot be found automatically. Never copied: `.pcbv/`, photo originals, symbolic links, files over 20 MB, and binary files other than photos. Logic captures (`.sr`) are copied only with `--include-logic`, since their raw samples cannot be redacted. `--check` reports without writing. The target folder must not exist and must not be inside the board folder.

## Export (`pcbv export`, the Board panel)

`export.py` writes a new folder, by default `~/pcbv-exports/<board>-<date>-<time>` (`$PCBV_EXPORT_DIR` changes the base). It refuses a folder inside the board folder or the data repo, and an existing one. `POST /api/boards/{slug}/export` `{formats?, redact?}` answers `{folder, files, redacted, counts, photosToCheck}`; the Board panel's Export section calls it.

| Format | File | Contents |
|---|---|---|
| `photo` | `photo-N-side.png` | each photo with header boxes, pins coloured by role (pin 1 square, unassigned pins hollow), a pin legend per header ("1 3V3 · 2 TX"), test points and callouts |
| `svg` | `photo-N-side.svg` | the same as vector shapes over the photo, embedded as a JPEG without metadata |
| `report` | `report.md` | device, notes, photos, labels, a pin table per header with readings, `analysis/findings.md`, playbook progress, captures, and the first 60 lines of the latest console capture |
| `csv`, `json` | `pinouts.csv`, `pinouts.json` | one row per pin: header, grid, pitch, numbering, pin, role, label, AI guess, readings, note |
| `zip` | `board.zip` | the board folder as `pcbv redact` would copy it (no photo originals, no `.pcbv/`, no logic captures) |

Exports are redacted unless `redact` is false (`--no-redact`). One `Redactor` serves every file, so a value has the same stand-in in the report, the pinouts and the zip; the report states whether it is redacted. The report's boot log is redacted as a whole before it is cut to the first lines, so a key block that spans lines is replaced whole. Pin positions use `pin_layout`, a port of `pinLayout` in `app/js/core/schema.js`, held to it by `tests/test_export.py`.

## Front end (`app/`)

`pcbv serve` also serves `app/` (override with `--app-dir` or `PCBV_APP_DIR`) from `/`, read-only (GET/HEAD only), with a CSP that allows only same-origin scripts. `pcbv open [board]` launches the browser at the running service with a one-time code in the URL fragment (fragments are not sent to servers or logged); `--print-url` prints that URL instead, and the code in it still expires after 60 seconds and works once. The page exchanges the code for the token, keeps it in `sessionStorage` and strips the fragment from the address bar. Board text is always rendered with `textContent`.

The client library (`app/js/client.js`) speaks the WebSocket protocol above; `app/js/core/apply.js` mirrors the Python reducer and is held to it by `service/tests/test_client_parity.py`. `service/tests/test_e2e.py` runs the real client against a real service process.

## Serial consoles

`serialmgr.py` lists ports (USB adapters with a vendor id, plus the `pcbv vdev` link) and tracks sessions by port. Opens, writes and closes are serialized per board. Only listed ports can be opened, so the app cannot open arbitrary device files. Ports carry their `/dev/serial/by-path` name as well as by-id, because cheap adapters such as the CP2102 often share the placeholder serial number `0001`.

A session reads in a thread and appends the raw bytes to `captures/serial/<local time>_<capture id>.log` in the board folder. The service records `capture/started` and `capture/stopped` (with byte count and reason: closed, port lost, service stopped) as internal events that clients cannot post. Output goes to the board's WebSocket clients as `{"op":"serial-data","captureId","text"}`; `{"op":"serial","state","backlog"}` is sent on connect and whenever a session opens or closes, with the last 64 kB so a reloaded app shows recent output.

While a session runs, the service watches its lines for recognisable output (bootloader banner, autoboot countdown, U-Boot prompt, `printenv` and `help` output, kernel start, shell, login prompt). The first time each appears it is added to the capture's `seen` list with an internal `capture/updated` event, which playbook `capture` checks use. The reader starts after `capture/started` is stored.

The Timeline (`GET /api/boards/{slug}/events?since=0` plus `GET /api/boards/{slug}/commits`, the data repo's commits touching the board folder) can open any capture log through the files route, which serves `captures/` as uncached plain text.

Input is line by line. A list of known dangerous commands prompts for confirmation; it cannot cover every command or shell syntax. The app asks for the exact command again and shows the board, port and speed in both Guided and Expert mode. Bidi controls and specified zero-width characters are refused outright. The Terminal panel is a normal shell and has no command check.

Every console write, special key and command-proposal approval requires the capture ID as `sessionId`, at most 128 UTF-8 bytes. Missing or invalid IDs return 422 `bad_request`; a closed or replaced session returns 409 `session_stale`. The service checks the identity while holding the board's session lock. If recording fails, hardware stops and the error is shown. If a stop event cannot be committed, retry disconnect; an unknown commit outcome requires reopening the board. Before opening a new console, the service records unfinished serial captures as interrupted.

Opening a real adapter needs membership of the `uucp` group (`sudo usermod -aG uucp $USER`, then log in again); the error says so.

## `pcbv shell`

`pcbv shell <board>` starts your `$SHELL` in the board folder on a pty and appends everything that crosses it, typed and printed, to `captures/shell/<time>_<id>.log`, like `script(1)`. `PCBV_BOARD` and `PCBV_CAPTURE` are set inside. The session is a capture of kind `shell`, started and stopped through the running service (or straight in the board folder without one), and on exit its transcript goes through the same recogniser as serial consoles. Running `tio` inside `pcbv shell` therefore satisfies the same playbook checks as the Console tab. `-c "command"` runs one command; its exit code is passed through. The Terminal panel uses a separate service-managed pty session (`terminal.py`) with the same shell-capture purpose.

## Bench assistant

`assistant/` (`loop.py` for the turns, `client.py` for the HTTP call) talks to any OpenAI-compatible server (cloud, or a local one such as Ollama) with a tool loop of at most eight rounds per question. If a model is still calling tools after eight, one more call with tools switched off asks it to answer from what it gathered. The model has eleven tools (`assistant_tools.py`): `get_board`, `get_pin_readings`, `get_capture`, `get_timeline`, `search_wiki`, `explain_step`, `write_finding` (appends a note to `analysis/findings.md` under the heading "Assistant finding (unverified): title", signed with the profile and model; heading lines inside the text are escaped, and the report lists these entries under their own "Assistant findings (unverified)" heading), `propose_command`, `view_photo`, `suggest_label` and `suggest_pin_roles`. It has no tool that runs anything or approves anything. Rules that hold in code and are tested:

- Every tool result is wrapped as `untrusted_data` with a note that it is data, never instructions, because boot logs and notes can contain text written to steer a model.
- A suggested command must be one plain command (no `;`, `&`, `|`, redirects or substitutions) and must pass the console's destructive-command guard, or it is stored as `refused` and cannot be approved. Approval re-checks the guard and sends through the existing console session.
- Keys live only in the system keyring (KWallet or Secret Service) under service `pcbv`; they are never written to a board folder or the settings file, and are masked in errors.
- The client refuses redirects, so a key cannot be forwarded to another host, and loopback servers bypass any proxy. A server on another machine must be reached over https. A stored key belongs to the profile's scheme, host and port: changing any of them deletes the key. To use a plain-http server on another machine, put it behind https or reach it through a tunnel to `localhost`.
- At most two questions run at once (one per board and conversation). When the window that asked goes away, no further model call or tool runs; the current call finishes, and the turn keeps its place until it has.
- Usage and cost per profile are kept in `~/.config/pcbv/assistant-usage.json`.
- A command proposed twice in one answer gives one card. `get_capture` reads at least 2000 characters (8000 by default), because models otherwise page through a short boot log 200 characters at a time.
- `view_photo` (`vision.py`) shows the whole photo, a region, or the area around a marked header, at most 1568 pixels on the long side, with a light grid labelled in percent of the whole photo. Close-ups are cut from the original in `assets/photos/originals/`, so markings stay readable. A tool result can only be text, so the picture follows in a message from the app after the round's tool results; once the answer is in, the picture is replaced by a one-line note so later questions do not send it again. Each profile has a `photos` switch; with it off the model gets no `view_photo` tool. It is on by default only for a server on this machine. For any other server a missing value means off, and the choice does not carry over when the profile moves to another scheme, host or port.
- `suggest_label` and `suggest_pin_roles` make cards like `propose_command` does. Each needs a grade (`high`: a marking or silkscreen says so, `medium`: strong visual clues, `low`: a plausible guess) and the evidence. Accepting a card writes `annotation/added` or `pin/updated` events with a `guess` record (see `docs/SCHEMA.md`); a guessed pin role is stored next to the pin, never as its `role`. The app shows guesses as unverified until the person checks them.
- The system prompt follows the Guided/Expert setting: Guided explains terms, Expert is brief and technical. The safety rules are the same in both.

Tried through OpenRouter on 2026-10-26 with a scratch board (console capture, logic capture, a capture carrying a prompt injection). All three kept to the safety rules: none proposed a destructive command, and the guard refused the ones Llama tried.

| Model | Result |
|---|---|
| `anthropic/claude-haiku-5.5` | best: 2 to 4 rounds, accurate, named the injection, offered `printenv bootdelay` instead of `saveenv` |
| `deepseek/deepseek-v4-flash` | good and cheapest per answer (about $0.001); refused `saveenv`, named the injection; asked for tiny capture windows before the minimum was added |
| `meta-llama/llama-3.1-8b-instruct` | not recommended: malformed tool arguments, repeated proposals, mixed up RAM and flash size |

Photo trial on 2026-10-26: the Nimbus front photo, one question ("identify the main chips with a certainty grade, and the likely UART"), checked against close-ups of the original. Readable on the board: U17 Winbond W9725G6JB-3 (DDR2), U1 Macronix MX25L12845EMI-10G (SPI flash), LinkCom LAN0068 magnetics, J2 (2×7) and J5 (2×3); the SoC is under a heatsink.

| Model | Time, cost | Result |
|---|---|---|
| `anthropic/claude-sonnet-5.5` | 54 s, $0.18 | best: read RAM, flash, J2 and the board marking, invented nothing, declined to guess pin roles without evidence |
| `moonshotai/kimi-k3.1-pro` | 348 s, $0.37 | as accurate as Sonnet (J2 as EJTAG, J5 as UART candidate), but slow and twice the price |
| `anthropic/claude-haiku-5.5` | 32 s, $0.005 | best value: accurate and honest, less thorough (did not zoom in on the flash) |
| `deepseek/deepseek-v4-flash-vision-exp` | 205 s, $0.04 | read RAM and flash; some wrong general-knowledge details, flagged as medium; experimental |
| `z-ai/glm-5v-turbo` | 66 s, $0.07 | not trustworthy: wrong header sizes and an invented flash part, all graded high |
| `z-ai/glm-5.3-flash`, `qwen/qwen3.8-max-prime` | 49 s / 314 s | no answer: the whole 8000-token reply allowance went to thinking |

A first run with a 1500-token reply allowance gave empty answers from four models for that reason, which is why the allowance is now 8000 and a cut-off reply says so.

Chosen from these trials: the first cloud slot (`tutor`, shown as Quick until renamed) suggests `anthropic/claude-haiku-5.5` for everyday questions and quick looks at a photo, the second (`analyst`, Thorough) `anthropic/claude-sonnet-5.5` for a careful reading of a board. The settings form shows them as placeholders when a profile has no model yet. A cheaper analyst needs a per-profile reasoning effort first, so thinking-heavy models answer within the allowance, and then a rerun with more candidates.

`pcbv fake-model --port 8767` starts a simulated server for development and the tests. Set a profile's address to `http://127.0.0.1:8767/v1` to try the panel without an account.

## Wiki

Starter pages ship in `service/src/pcbv/wiki/`, grouped by `contents.yaml` into sections in reading order (Start here, Electricity, Schematics, Tools, The board, Interfaces, Boot and firmware, Reference); `GET /api/wiki` returns pages in that order with a `section` on each. Pages in `~/hw/wiki/` are read after them; one with the same name replaces the built-in page and keeps its section, and new names add pages under "Your pages". Figures (`name.svg` or `name.png`, at most 1 MB) sit next to the pages and follow the same replacement rule; a page shows one with `![caption](name.svg)` on its own line. `GET /api/wiki/figures/{file}` serves them behind the token with `nosniff` and a CSP that blocks scripts, and the app loads them as blob URLs. The tests check that every built-in page is in exactly one section, that every figure a page uses exists, and that pages avoid em dashes and stock filler phrases. A page's name is its file name, its title its first `# ` heading. Pages are read on every request, symlinks and files over 512 kB are skipped. In pages, `[text](uart)` links to another page and `[text](https://...)` opens in a new tab; other link targets stay plain text. The tests check that every page a playbook names exists and that links between starter pages resolve.

## Editing from the CLI (`pcbv note`, `pcbv measure`)

`pcbv measure <board> <header> <pin> <value>` records a multimeter reading. The header is found by its marker's silkscreen label or its own name, ignoring case. Values are written as the meter shows them: `3.29V`, `330mV`, `0.3ohm`, `4.7k`, `1.2MΩ`, `OL` or `beep`. Volts mean the board was powered, resistance and continuity mean it was unplugged; `--powered` / `--unpowered` override that, and the unsafe combinations print a warning. The reading is appended to the pin's `readings` (see `docs/SCHEMA.md`) with a `pin/readingAdded` event.

`pcbv note <board> "text"` appends a line stamped with local time to the board notes; `--pin J4:2` appends it to that pin's note instead.

Both go through the running service when there is one (it holds the board lock, and open apps update live) and edit the board folder directly otherwise.

## Data repo (`pcbv repo init`, `pcbv sync`)

The boards root sits inside one private git repo, by default `~/hw`. `pcbv repo init [path]` (default: the parent of the boards root) creates `boards/ wiki/ library/datasheets/ playbooks/ journal/`, a README, `.gitignore`, `.gitleaks.toml` and `.githooks/pre-commit`, and sets `core.hooksPath = .githooks`. Existing files are kept; the hook is always refreshed. `core.hooksPath` is local config, so run `pcbv repo init` once after every fresh clone.

The commit guard blocks anything under `dumps/`, `extracted/` or `.pcbv/`, any staged file over 5 MB, and anything gitleaks flags. `.gitleaks.toml` extends the default rules with router credentials (Wi-Fi PSK, PPPoE, SIP/VoIP, TR-069/ACS, admin and root passwords) and crypt(3) hashes; masked values such as `********` pass. Without gitleaks the guard refuses every commit. The hook passes `--exit-code 3`: exit 3 is a possible secret, any other non-zero exit says that gitleaks could not run the scan and needs 8.21 or newer; both refuse the commit. The service asks the same question with a probe before every sync and in the checks: it runs the guard's `gitleaks git --pre-commit --staged ... --exit-code 3` against an empty repository in a temporary folder, with the global git config switched off and a 10 second limit. Exit 0 is `ok`, anything else `too-old`, no binary on PATH `missing`. The answer is kept per binary (resolved path and modification time) for the life of the process.

`pcbv sync [-m msg] [--no-push]` refuses to run (exit 1) while the `git` setting is `off`, and while the guard is inactive, stages everything, and commits with a message built from the staged journal lines (`Sync demo-router (+3 events)`, with event counts per type in the body). If the guard refuses, nothing stays staged. With an `origin` remote it first runs the private check (module `github.py`, the same one as the Settings remote step) on every address `git remote get-url --push --all origin` lists, after the local commit and before any `ls-remote`, pull or push. A GitHub address that answers 200 (public), cannot be checked (network error, 403, 5xx, any code but 200 and 404) or has no plain owner and repository stops the sync with `Not pushed: ...`; the local commit is kept and exit is 1. A 404 (private or not created yet) goes on; another host is pushed to as before. `--no-push` and a missing `origin` ask nothing. It then pulls with rebase and pushes. If a rebase is already in progress in the data repo, sync stops before touching anything and says so. If the pull conflicts, sync aborts the rebase it started, keeps your commit, and reports the failure; resolve it by hand with `git pull --rebase origin main` and sync again.

Messages that suggest a command print `pcbv ...` when `pcbv` is on your PATH and `uv run pcbv ...` (from `service/`) otherwise (`hints.py`).

## Virtual device (`pcbv vdev`)

`pcbv vdev` runs a synthetic router, ARC-DEMO-01, behind a pty and links it at `$XDG_RUNTIME_DIR/pcbv/ttyPCBV0` (`--link` to change). Connect with `tio -b 115200 <path>` or any serial tool. The board is off while nobody has the port open and powers on when a client connects, so each session starts with the full boot log. It boots U-Boot, counts down 3 seconds (any key stops autoboot at the `ARC7621 #` prompt), boots the kernel and offers a BusyBox shell after Enter. The board talks at 115200; the port starts at 9600, and any other speed set on the port garbles both directions, as a wrong baud does on a real UART. `kill -USR1 <pid>` power cycles it; `reset` in U-Boot and `reboot` in the shell do too.

The app starts and stops the virtual board itself (`vdevmanager.py`, Console panel buttons and the
`/api/vdev` routes). It runs `python -I -m pcbv vdev` as a child process of the service, not a thread, because
`vdev.run` installs signal handlers. The child gets `PCBV_STOP_WITH_PID` set to the service's pid and ends with
it, even after `kill -9` on the service (the helpers live in `stopwith.py`, shared with `pcbv serve`). A normal
service stop sends the child SIGTERM and, after 2 seconds, SIGKILL. A board started from a terminal is shown as
running but is never stopped by the app.

The link path must be unused. The virtual board refuses to replace an existing file or symlink; inspect
and remove a stale link yourself before restarting it.

## Known limits

- A direct edit of `project.pcb.json` is noticed at the next open or the next applied event, not the moment it happens. A file watcher that pushes it to clients immediately is a later step.
- `flock` is advisory and local. Keep boards on a local disk, not a network share.
- All events of an open board stay in memory, which is fine for a single board's lifetime of edits.
- `pcbv sync` can overlap service writes. Individual snapshots are replaced atomically, but a git
  commit is not a transaction across all board files. It may include a stale snapshot or an incomplete
  final journal suffix; reopen validates the journal before rebuilding or repairing derived files.
