"""pcbv command line: new, demo, status, serve, open, note, measure, shell, repo init, sync, redact, export, vdev, fake-capture, fake-model, kwin-rules."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import sys
import urllib.request
import webbrowser
from pathlib import Path

from .fsutil import ensure_directory

from .board import Board, BoardLocked, BoardNotFound, inspect_board, write_agents_md
from .boards import InvalidSlug, board_path, default_root, list_boards, slugify
from .datarepo import RepoError, find_repo, init_repo, sync
from .edits import EditError, HttpWriter, LocalWriter, note_event, reading_event
from .events import EventConflict, EventError
from .hints import command
from .journal import JournalError
from .redact import RedactError, redact_board
from .demo import create_demo
from .export import FORMATS, ExportError, default_folder, export_board
from .kwin import TITLES as KWIN_TITLES
from .net import is_loopback
from .settings import assistant_on
from .settings import load as load_settings
from .runtime import mint_code, read_service_info, remove_service_info, write_service_info
from .stopwith import stop_when_process_ends, watched_pid



def default_app_dir() -> Path | None:
    """The front end folder: $PCBV_APP_DIR, else app/ next to service/ in this repo checkout."""
    candidates = [os.environ.get("PCBV_APP_DIR"), Path(__file__).resolve().parents[3] / "app"]
    for candidate in candidates:
        if candidate and (Path(candidate) / "index.html").is_file():
            return Path(candidate)
    return None

SNAPSHOT_HINTS = {
    "in-sync": "project.pcb.json matches the journal.",
    "missing": "project.pcb.json is missing. The service will rebuild it.",
    "corrupt": "project.pcb.json cannot be read. The service will keep a copy and rebuild it.",
    "stale": "project.pcb.json is behind the journal because a write was interrupted. The service will refresh it.",
    "external-edit": "project.pcb.json was edited outside the app. When you reopen the board, the service keeps a recovery copy and rebuilds the file.",
}


def live_service() -> dict | None:
    """The advertised service, but only if it answers. A pid alone is not proof: after a crash the
    advertisement can outlive the process, and the pid can even be reused by something else."""
    info = read_service_info()
    if info is None:
        return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never route loopback via a proxy
    try:
        with opener.open(info["url"] + "/api/health", timeout=0.7) as response:
            health = json.load(response)
            if response.status == 200 and health.get("ok") is True:
                if type(health.get("protocol")) is not int or health["protocol"] != 2:
                    raise EditError("The running service uses a different protocol version. Restart it with this version of pcbv.")
                return info
    except EditError:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def cmd_new(args) -> int:
    root = Path(args.root)
    slug = slugify(args.name)
    directory = board_path(root, slug)
    ensure_directory(root.resolve())
    board = Board.create(directory, args.name.strip(), agents_md=assistant_on(root))
    board.close()
    print(f"Created the board '{args.name.strip()}' at {directory}")
    print(f"Check it with: {command('status', slug)}")
    return 0


def _describe(slug: str, info: dict) -> list[str]:
    counts = info["counts"]
    lines = [
        f"{slug}: {info['name']}" + (f" ({info['device']})" if info["device"] else ""),
        f"  events    {info['seq']}  (last change {info['modified']})",
        f"  contents  {counts['assets']} photos, {counts['markers']} markers, "
        f"{counts['schematics']} headers, {counts['components']} components",
        f"  snapshot  {SNAPSHOT_HINTS[info['snapshot']]}",
    ]
    if info["journal_torn_tail"]:
        lines.append("  journal   The journal ends in an incomplete line after a crash. The service repairs it on the next start.")
    if info["open_in_service"]:
        lines.append("  lock      The board is open in a running service.")
    return lines


def cmd_demo(args) -> int:
    directory = create_demo(Path(args.root))
    print(f"Created the demo board in {directory}")
    print(f"Open it with: {command('open', 'demo-router')}")
    print("The service must be running.")
    return 0


def cmd_status(args) -> int:
    root = Path(args.root)
    service = live_service()
    slugs = [args.board] if args.board else list_boards(root)
    report = {}
    for slug in slugs:
        report[slug] = inspect_board(board_path(root, slug))
    if args.json:
        print(json.dumps({"root": str(root), "service": service and service["url"], "boards": report}, indent=2))
        return 0
    print(f"boards root  {root}")
    print(f"service      {service['url'] if service else 'not running'}")
    if not report:
        print(f"There are no boards yet. Create one with: {command('new', '\"Board name\"')}")
    for slug, info in report.items():
        print()
        print("\n".join(_describe(slug, info)))
    return 0


def cmd_serve(args) -> int:
    if not is_loopback(args.host):
        print(f"pcbv: the service cannot listen on {args.host}. It is for this machine only.", file=sys.stderr)
        return 2
    try:
        watched = watched_pid()
        watch_fd = os.pidfd_open(watched) if watched else None
    except ValueError:
        print("pcbv: PCBV_STOP_WITH_PID must be a process id.", file=sys.stderr)
        return 2
    except ProcessLookupError:
        print("pcbv: the app that started this service has already quit.", file=sys.stderr)
        return 1
    try:
        return serve(args, watch_fd)
    finally:
        if watch_fd is not None:
            os.close(watch_fd)


def serve(args, watch_fd: int | None) -> int:
    import uvicorn

    from .server import create_app

    running = live_service()
    if running:
        print(f"pcbv: a service is already running at {running['url']}", file=sys.stderr)
        return 1
    root = Path(args.root)
    ensure_directory(root.resolve())
    token = secrets.token_urlsafe(32)
    app_dir = Path(args.app_dir) if args.app_dir else default_app_dir()
    app = create_app(root, token, app_dir)
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    sock = config.bind_socket()                   # bound before advertising, so --port 0 reports the real port
    host = f"[{args.host}]" if ":" in args.host else args.host
    url = f"http://{host}:{sock.getsockname()[1]}"
    info_path = write_service_info(url, token)
    print(f"pcbv service is running at {url}", flush=True)
    print(f"Boards folder: {root}", flush=True)
    print(f"The token and address are in {info_path}. Only you can read that file.", flush=True)
    if app_dir:
        print(f"Front end: {app_dir}", flush=True)
    else:
        print("Front end: none found. Set --app-dir or PCBV_APP_DIR.", flush=True)
    print(f"Open it with: {command('open')}", flush=True)
    # uvicorn shuts down on SIGTERM and then re-raises the signal to the previous handler. With the
    # default handler that kills the process before the cleanup below can run and leaves a stale
    # advertisement behind, so turn the re-raised signal into a normal exit.
    def exit_on_signal(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, exit_on_signal)
    try:
        if watch_fd is not None:
            stop_when_process_ends(watch_fd)
        uvicorn.Server(config).run(sockets=[sock])
    finally:
        remove_service_info()
    return 0


def cmd_open(args) -> int:
    info = live_service()
    if info is None:
        print(f"pcbv: no service is running. Start one with: {command('serve')}", file=sys.stderr)
        return 1
    try:
        code = mint_code(info)
    except OSError as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
        return 1
    # A one-time code (60 seconds, one use) in the URL fragment, which browsers never send to any server.
    # The token itself never appears in a URL or on a command line.
    fragment = f"code={code}" + (f"&board={args.board}" if args.board else "")
    url = f"{info['url']}/#{fragment}"
    if args.print_url:
        print(url)
        return 0
    if not webbrowser.open(url):
        print(f"pcbv: could not start a browser. Open {info['url']} and paste the token from the service file.",
              file=sys.stderr)
        return 1
    print(f"Opened {info['url']} in your browser. The URL fragment carries a one-time code, not the token.")
    return 0


def _writer(args):
    """Through the running service when there is one (it holds the board lock), else directly."""
    service = live_service()
    if service:
        return HttpWriter(service, args.board), "service"
    return LocalWriter(Path(args.root), args.board), "board folder"


def cmd_note(args) -> int:
    writer, via = _writer(args)
    try:
        writer.apply(note_event(writer.project, args.text, args.pin))
    finally:
        writer.close()
    print(f"Added a note to {args.pin or args.board} through the {via}.")
    return 0


def cmd_measure(args) -> int:
    writer, via = _writer(args)
    try:
        event, reading, warnings = reading_event(writer.project, args.header, args.pin, args.value, args.powered)
        for warning in warnings:
            print(f"pcbv: warning: {warning}", file=sys.stderr)
        writer.apply(event)
    finally:
        writer.close()
    state = "powered" if reading["powered"] else "unpowered"
    print(f"{args.header} pin {args.pin}: {reading['text']} ({reading['mode']}, {state}). Saved through the {via}.")
    return 0


def cmd_repo_init(args) -> int:
    repo = Path(args.path) if args.path else Path(args.root).parent
    created = init_repo(repo)
    print(f"data repo  {repo}")
    print("created    " + (", ".join(created) if created else "nothing new. The layout was already complete."))
    print("guard      active (core.hooksPath = .githooks)")
    if Path(args.root).resolve().parent != repo.resolve():
        print(f"note       The boards root {args.root} is not {repo}/boards. Pass --root to point pcbv at it.")
    return 0


def cmd_sync(args) -> int:
    if load_settings(Path(args.root))["git"] != "on":
        print("pcbv: pcbv sync needs git, and git is off. To turn it on, open Settings in the app. The Git section "
              "checks the tools, prepares the data folder and turns git on.", file=sys.stderr)
        return 1
    repo = find_repo(Path(args.root))
    if repo is None:
        print(f"pcbv: {args.root} is not inside a git repo. Create one with: {command('repo', 'init')}", file=sys.stderr)
        return 1
    print(f"data repo  {repo}")
    for line in sync(repo, push=not args.no_push, message=args.message):
        print(f"  {line}")
    return 0


def cmd_redact(args) -> int:
    board_dir = board_path(Path(args.root), args.board)
    if not (board_dir / "journal" / "events.jsonl").is_file():
        raise BoardNotFound(f"{board_dir} is not a board")
    out = None if args.check else Path(args.out or f"{args.board}-redacted").resolve()
    repo = find_repo(board_dir)
    if out is not None and repo is not None and (out == repo or repo.resolve() in out.parents):
        raise RedactError(f"{out} is inside the data repo {repo}, and sync would commit it there. Choose a folder outside the repo.")
    report = redact_board(board_dir, out, include_logic=args.include_logic, photos=not args.no_photos)
    counts = report.counts()
    summary = ", ".join(f"{n} {kind}" for kind, n in sorted(counts.items())) or "nothing matched"
    print(f"{args.board}: {summary}")
    for name, why in report.left_out:
        print(f"  left out {name}: {why}")
    if report.photos:
        print(f"  Check {len(report.photos)} photo(s) by eye for labels and stickers. pcbv removed the photo metadata.")
    if out is None:
        print("This was a check only. Nothing was written. To write a redacted copy, run the command again without --check.")
    else:
        print(f"Redacted copy: {out}")
        print(f"Report: {out / 'REDACTION.md'}")
    return 0


def cmd_export(args) -> int:
    board_dir = board_path(Path(args.root), args.board)
    if not (board_dir / "journal" / "events.jsonl").is_file():
        raise BoardNotFound(f"{board_dir} is not a board")
    formats = args.format.split(",") if args.format else list(FORMATS)
    result = export_board(board_dir, Path(args.out) if args.out else default_folder(args.board), formats,
                          redact=not args.no_redact)
    print(f"Exported {len(result.files)} files to {result.folder}:")
    for name in result.files:
        print(f"  {name}")
    if result.redacted:
        replaced = ", ".join(f"{n} {kind}" for kind, n in sorted(result.counts.items())) or "nothing matched"
        print(f"Redacted. Distinct values replaced: {replaced}. Check the photos by eye before you share them.")
    else:
        print("Not redacted. Keep this export private.")
    return 0


def cmd_shell(args) -> int:
    from .shell import RecordingError, run

    try:
        return run(Path(args.root), args.board, live_service(), command=args.command)
    except RecordingError as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
        return 1


def assistant_off_message(what: str) -> str:
    return (f"pcbv: {what} needs the assistant, which is off. To turn it on, open Settings in the app "
            "and switch on the Assistant section.")


def cmd_agents_md(args) -> int:
    if not assistant_on(Path(args.root)):
        print(assistant_off_message("pcbv agents-md"), file=sys.stderr)
        return 1
    directory = board_path(Path(args.root), args.board)
    info = inspect_board(directory)
    if write_agents_md(directory, info["name"], overwrite=args.force):
        print(f"Wrote {directory / 'AGENTS.md'}")
    else:
        print(f"{directory / 'AGENTS.md'} exists, so pcbv kept it. To replace it, use --force.")
    return 0


def cmd_kwin_rules(args) -> int:
    from .kwin import RuleError, parse_assignments, rules_file

    try:
        text = rules_file(parse_assignments(args.windows), maximize=args.maximize)
    except RuleError as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
        return 2
    out = Path(args.output)
    out.write_text(text, encoding="utf-8")
    print(f"Wrote {out}")
    print("To use it, import it in System Settings > Window Management > Window Rules > Import...")
    print("Then reopen the windows.")
    print("Monitors are numbered from 0 in the order KWin lists them.")
    return 0


def cmd_fake_capture(args) -> int:
    from .logic import format_rate, virtual_boot_capture, write_sr

    capture = virtual_boot_capture(args.baud, args.rate)
    Path(args.output).write_bytes(write_sr(capture))
    print(f"Wrote {args.output}. The logic capture shows a boot of the virtual board: UART at {args.baud} baud on D0, "
          f"sampled at {format_rate(args.rate)}, {capture.duration:.2f} s. Import it in the Logic panel.")
    return 0


def cmd_fake_model(args) -> int:
    import time

    if not assistant_on(Path(args.root)):
        print(assistant_off_message("pcbv fake-model"), file=sys.stderr)
        return 1

    from .fakemodel import FakeModelServer

    server = FakeModelServer(args.port).start()
    print(f"Simulated model server at {server.base_url}")
    print("It is not a real model. Use it for practice and tests.")
    print("In Settings, in the Assistant section, enter this base URL and any model name. Leave the key empty.")
    print("To stop the server, press Ctrl-C.")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()
    return 0


def cmd_vdev(args) -> int:
    from .vdev import run

    try:
        watched = watched_pid()
        watch_fd = os.pidfd_open(watched) if watched else None
    except ValueError:
        print("pcbv: PCBV_STOP_WITH_PID must be a process id", file=sys.stderr)
        return 2
    except ProcessLookupError:
        print("pcbv: the app that started this virtual board has already quit.", file=sys.stderr)
        return 1
    try:
        return run(Path(args.link) if args.link else None, watch_fd=watch_fd)
    finally:
        if watch_fd is not None:
            os.close(watch_fd)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pcbv", description="PCB Visualizer service and board tools")
    parser.add_argument("--root", default=str(default_root()),
                        help="folder that holds the boards (default: $PCBV_BOARDS_ROOT or ~/hw/boards)")
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="create a board folder")
    new.add_argument("name", help='board name, for example "Nimbus N100"')
    new.set_defaults(func=cmd_new)

    demo = sub.add_parser("demo", help="create the demo board: a synthetic router with headers, pins, callouts and captures")
    demo.set_defaults(func=cmd_demo)

    status = sub.add_parser("status", help="show boards and whether their files are consistent")
    status.add_argument("board", nargs="?", help="board folder name; omit to list all")
    status.add_argument("--json", action="store_true", help="machine-readable output")
    status.set_defaults(func=cmd_status)

    serve = sub.add_parser("serve", help="run the local service")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765, help="port on this machine. 0 picks a free port, and service.json names it")
    serve.add_argument("--app-dir", help="front end folder to serve (default: app/ in this checkout)")
    serve.set_defaults(func=cmd_serve)

    open_ = sub.add_parser("open", help="open the front end in your browser, signed in to the running service")
    open_.add_argument("board", nargs="?", help="board folder name to show first")
    open_.add_argument("--print-url", action="store_true", help="print the URL instead of opening a browser. The URL holds a one-time code that is valid for 60 seconds")
    open_.set_defaults(func=cmd_open)

    note = sub.add_parser("note", help="add a timestamped note to a board, or to one pin with --pin")
    note.add_argument("board", help="board folder name")
    note.add_argument("text", help="the note")
    note.add_argument("--pin", help="HEADER:NUMBER, for example J4:2")
    note.set_defaults(func=cmd_note)

    measure = sub.add_parser("measure", help="record a multimeter reading on a pin",
                             description="Record a reading. A voltage (3.29V, 330mV) means the board was powered. "
                                         "A resistance (0.3ohm, 4.7k), OL or beep means it was unplugged. "
                                         "To override this, use --powered or --unpowered.")
    measure.add_argument("board", help="board folder name")
    measure.add_argument("header", help="silkscreen label or header name, for example J4")
    measure.add_argument("pin", type=int, help="pin number")
    measure.add_argument("value", help="3.29V, 330mV, 0.3ohm, 4.7k, OL or beep")
    power = measure.add_mutually_exclusive_group()
    power.add_argument("--powered", dest="powered", action="store_true", default=None)
    power.add_argument("--unpowered", dest="powered", action="store_false")
    measure.set_defaults(func=cmd_measure)

    repo = sub.add_parser("repo", help="manage the data repo that holds the boards")
    repo_sub = repo.add_subparsers(dest="repo_command", required=True)
    repo_init = repo_sub.add_parser("init", help="create the data repo layout and activate the commit guard")
    repo_init.add_argument("path", nargs="?", help="repo folder (default: the parent of the boards root, ~/hw)")
    repo_init.set_defaults(func=cmd_repo_init)

    sync_ = sub.add_parser("sync", help="commit all changes in the data repo through the guard, then pull and push")
    sync_.add_argument("-m", "--message", help="commit message (default: built from the board journals)")
    sync_.add_argument("--no-push", action="store_true", help="commit only")
    sync_.set_defaults(func=cmd_sync)

    redact = sub.add_parser("redact", help="write a copy of a board with secrets, serial numbers and addresses replaced, for sharing",
                            description="Write a redacted copy of a board. pcbv does not change the board. Add strings of your "
                                        "own to .pcbv/redact.txt in the board folder, one per line. "
                                        "An example is a serial number from the label.")
    redact.add_argument("board", help="board folder name")
    redact.add_argument("--out", help="folder for the copy, which must not exist yet (default: ./BOARD-redacted)")
    redact.add_argument("--check", action="store_true", help="report what pcbv would replace, and write nothing")
    redact.add_argument("--include-logic", action="store_true", help="copy logic captures (.sr) without redaction, because pcbv cannot redact them")
    redact.add_argument("--no-photos", action="store_true", help="leave photos out of the copy")
    redact.set_defaults(func=cmd_redact)

    export = sub.add_parser("export", help="export a board: annotated photos, a Markdown report, pinouts, a zip",
                            description="Export a board. The export is redacted unless you give --no-redact. Formats: " + ", ".join(FORMATS) + ".")
    export.add_argument("board", help="board folder name")
    export.add_argument("--out", help="new folder for the files (default: ~/pcbv-exports/BOARD-DATE-TIME, or $PCBV_EXPORT_DIR)")
    export.add_argument("--format", help="comma-separated list, for example photo,report (default: all)")
    export.add_argument("--no-redact", action="store_true", help="keep serial numbers, addresses and credentials. Use it for private exports only")
    export.set_defaults(func=cmd_export)

    shell = sub.add_parser("shell", help="open a shell in a board folder that records the whole session",
                           description="pcbv saves all input and output to captures/shell/ in the board folder. "
                                       "The app shows the capture in the timeline. "
                                       "To capture a serial console, run tio inside the shell.")
    shell.add_argument("board", help="board folder name")
    shell.add_argument("-c", "--command", help="run one command instead of an interactive shell")
    shell.set_defaults(func=cmd_shell)

    agents = sub.add_parser("agents-md", help="write AGENTS.md, the briefing for coding agents, into a board folder")
    agents.add_argument("board", help="board folder name")
    agents.add_argument("--force", action="store_true", help="replace an existing AGENTS.md")
    agents.set_defaults(func=cmd_agents_md)

    kwin = sub.add_parser("kwin-rules", help="write KWin window rules that pin desktop windows to monitors",
                          description="Example: pcbv kwin-rules main=0 console=1 timeline=1. The command writes a .kwinrule file "
                                      "that you import in System Settings. It does not change your KWin configuration.")
    kwin.add_argument("windows", nargs="*", help="window=monitor pairs: " + ", ".join(KWIN_TITLES))
    kwin.add_argument("--maximize", action="store_true", help="also maximise each window on its monitor")
    kwin.add_argument("-o", "--output", default="pcbv-windows.kwinrule", help="file to write (default: %(default)s)")
    kwin.set_defaults(func=cmd_kwin_rules)

    fake = sub.add_parser("fake-capture", help="write a logic capture of a virtual board boot, for practice")
    fake.add_argument("-o", "--output", default="virtual-boot.sr", help="file to write (default: %(default)s)")
    fake.add_argument("--baud", type=int, default=115200)
    fake.add_argument("--rate", type=int, default=1_000_000, help="sample rate in Hz (default: %(default)s)")
    fake.set_defaults(func=cmd_fake_capture)

    model = sub.add_parser("fake-model", help="run a simulated OpenAI-compatible model server for the assistant, for practice")
    model.add_argument("--port", type=int, default=8767, help="port on 127.0.0.1 (default: %(default)s)")
    model.set_defaults(func=cmd_fake_model)

    vdev = sub.add_parser("vdev", help="run the virtual board as a serial port (a pty), for practice")
    vdev.add_argument("--link", help="stable path for the port (default: $XDG_RUNTIME_DIR/pcbv/ttyPCBV0)")
    vdev.set_defaults(func=cmd_vdev)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except InvalidSlug as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
    except FileExistsError as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
    except FileNotFoundError as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
    except BoardNotFound as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
    except JournalError as exc:
        print(f"pcbv: journal problem: {exc}", file=sys.stderr)
    except (RepoError, EditError, EventError, EventConflict, BoardLocked, RedactError, ExportError) as exc:
        print(f"pcbv: {exc}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
