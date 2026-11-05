# Desktop shell and workspaces

## Panels and workspaces (any browser)

The board screen is made of panels: Board, Header, Changes, Photo, Playbook, Wiki, Console,
Timeline, Logic, Terminal and Agent. They sit in four regions (left, centre, right, bottom). Each region shows
its panels stacked or as tabs; the button at the right of a region's bar switches.

- Move a panel by dragging its tab (or the ⠿ grip of a stacked panel) onto another region, or with
  its ⋯ menu. An empty region is folded away; while a panel is dragged it opens up as a labelled drop
  target, so a panel can be dragged into it. The menu is a keyboard menu: arrow keys, `Home` and `End` move between items, `Esc` closes
  it and returns focus to the button, and `Tab` closes it and moves on. Tabs follow the usual tab
  pattern: the selected tab is the only one in the Tab order, and the arrow keys, `Home` and `End` move
  to another tab and show its panel. A stacked region has no tab list.
- A panel is in exactly one place: a region, its own window (`detached` in the saved layout), or put
  away (`away`). A layout saved before put-away existed loads with nothing away.
- The **Panels** button in the header, or `Ctrl+Shift+P`, opens a menu that lists every panel in a fixed
  order with its state (Left, Centre, Right, Bottom, Own window, Put away) and its actions. Docked:
  Show (tab to the front, focus on it), Open in own window, Put away. Own window: Focus window, Bring
  back. Put away: Show here. The Agent panel is not listed while the assistant is off. The menu is a
  keyboard menu like the panel menu below, and typing letters jumps to a panel by title. The shortcut
  works only in the main window, after the saved workspace has loaded. Firefox keeps `Ctrl+Shift+P`
  for private windows; the button works there.
- Each panel's own menu also has Put away. Show here and Bring back put a panel at its origin, the
  region and place it was last docked in, or at the end of the Right region if it has none. An action
  aimed at a panel that is put away (an Ask, a wiki link, a timeline jump) brings it back first. When
  every region is empty, the board area says so and has a button that opens the Panels menu.
- "Open in its own window" detaches a panel. The window shows only that panel and is titled
  `pcbv · Name`. Closing the window by its own controls brings the panel back to the place it came
  from, never to put away. If the browser blocks the pop-up, the panel stays where it is and a message
  says so.
- A workspace may ask for panels in their own windows (Console, Analysis and Wall do). Switching to it
  opens those windows, and a panel whose window cannot open stays in the main window. Switching away
  closes windows the next workspace does not want.
- After the main window is reloaded, panels whose windows are still open stay detached. In the desktop
  app they are found by their label. In a browser each panel window introduces itself to the window that
  opened it (same origin only) when it loads and whenever a main window starts; the main window waits up
  to half a second after it starts for these answers. A panel whose window cannot be found returns to its
  place, and the saved workspace is not rewritten by that. Such a window (for example one left from a
  main tab that was closed) is told its panel is home: it stops taking actions and closes itself, or
  says it can be closed if the browser keeps it open, so a question never runs in two windows. A window
  whose opener is still open ignores that message, so a second main tab cannot close another tab's
  panel windows. A browser window whose introduction arrives after the main window brought its panel
  home is told so directly, by a message to that window alone, and retires the same way.
- A panel window follows the board of the main window and has no board picker of its own. Once it has
  loaded its board it asks the main window for the current board and counter, so a panel window that was
  reloaded, or that finished loading after a board switch, is heard again at once.

### Actions between windows

Asking the Agent about something, opening a Wiki page and jumping to a photo, a playbook step or a
capture all go to the window that has the target panel. A panel docked in the window you are using is
shown and used directly. A panel in another window is brought to the front and sent the action over a
`BroadcastChannel` named `pcbv-panels`; if the panel is detached but its window is gone, it returns to
its place first.

The receiving window acknowledges before it runs the action, and the sender waits 2 seconds. Without an
answer the main window shows "Panel did not respond" with Retry and Bring back (a panel window shows
Retry only). Nothing is repeated automatically: a late acknowledgement runs nothing, and Bring back
only returns the panel without asking the question. Messages carry the board name and a counter the main
window raises on every board change, so a message for another board, or from before the last switch
(also A to B and back to A), is ignored. A message is at most 64 KiB, each window remembers the last 256
message IDs to drop duplicates, and only the actions ask, wiki and jump are accepted.

Limits: the channel alone cannot tell whether a window is alive, so a window that hangs looks the same as
one that is not there. A reloaded main window starts its counter from the clock, so panels opened before
the reload still accept its messages; one that does not can be fixed with Bring back. A browser without
`BroadcastChannel` shows a message instead of failing silently.
- Workspaces are named layouts, saved by the service in `~/.config/pcbv/workspaces.json`, so the
  browser and the desktop app share them. Learn, Console, Analysis and Wall are built in; changes
  to the current workspace are saved as you go, Reset layout puts a built-in one back, Save as keeps a copy.

The layout format is in `app/js/core/layout.js`.

## The desktop app

`desktop/` is a Tauri 2 shell around the same app. It does not contain its own copy of the front
end: the main window loads the app from the local service, so the browser stays a full fallback.

- On start it looks for a running service (`$XDG_RUNTIME_DIR/pcbv/service.json`, confirmed by
  `/api/health`). If there is none it starts one and stops it again on exit with SIGTERM; a service you
  started yourself is left alone. The shell also passes its own process id in `PCBV_STOP_WITH_PID`, and
  the service it started watches that process and shuts down the same way when it ends, so a shell that
  is killed (SIGTERM, SIGKILL) or crashes leaves no service behind. It runs `pcbv serve` when an executable `pcbv` is on `PATH`; else
  `uv run pcbv serve` in the folder named by `PCBV_SERVICE_DIR` (a set but unusable folder is an error,
  not skipped); in a debug build (`npm run desktop`) else the `service/` folder of this checkout. A
  release build never uses the folder it was built in. The AppImage launcher points `PYTHONHOME`,
  `PYTHONPATH`, `LD_LIBRARY_PATH`, `PATH` and other variables into the AppImage; the service is started
  with those entries removed, so it sees the environment the AppImage was started from.
- The service has 15 seconds to answer. If it does not, or it stops, the window shows why (the last
  lines of its error output), the command to fix it and a Retry button; Retry stops a service the app
  started and tries again. The health answer must carry `"protocol": 2`, as `pcbv` itself requires: a
  running service with another protocol is reported and left alone, and no second one is started next to it.
  The page is `desktop/ui/` (no script inline, a content security policy of `default-src 'self'`).
- `service.json` is checked before anything touches the network. It must be a regular file of at most
  64 KiB. The address must be plain `http://127.0.0.1:PORT`, `http://[::1]:PORT` or
  `http://localhost:PORT` with an explicit port (not 0 or 80) and no user name or password, path, query
  or fragment. The token must be 16 to 256 URL-safe characters. A file that fails a check counts as no
  running service; the service it names is not touched. Health probes and code requests connect only to
  loopback addresses (`localhost` without a name lookup), stop after 2 seconds, read at most 64 KiB and
  never follow redirects.
- The main window opens with a one-time login code that the shell mints from the advertised token
  (`POST /api/session/code`); the page exchanges it for the token. Each panel window gets a code of its own
  from the main window, so no token is in a navigation URL. A panel reloads from its own session storage.
- Panel windows are native windows, labelled `panel-<name>` and titled `pcbv · Name`.
- Native access is granted at runtime (`desktop/src-tauri/src/guard.rs`), after the address has been
  checked and before the main window is sent to the service. Only pages of that one origin
  (`http://HOST:PORT/*`, the checked host and port) in the `main` window and the eleven `panel-<name>`
  windows get it, and the splash gets none. The permissions are those the app's own calls need, with the
  JavaScript each serves: `core:window:allow-get-all-windows` (`WebviewWindow.getByLabel`, which lists
  windows), `core:webview:allow-create-webview-window` (`new WebviewWindow`), `core:window:allow-set-focus`
  (`setFocus()`) and `core:window:allow-close` (`close()` on a panel window), and `allow-open-link` (the `open_link`
  command, below). The constructor's
  `tauri://created` and `tauri://error` events stay inside the page and need no permission. No `default`
  permission set is included. A new native call in `app/js` needs its permission added to the list in
  `guard.rs`; check the command it invokes in Tauri's bundled API, because a denied call only shows up in
  the desktop app.
- Every webview, including panel windows the page opens itself, may load only the splash or the checked
  service's `/` with a query of at most `panel`, `board` and `gen` (each once, with the values the app
  writes), and any fragment. Other ports, hosts, schemes and paths are refused. This relies on Tauri
  calling the navigation hook for every load, and on the service never redirecting; whether WebKitGTK
  reports server redirects to the hook has not been verified.
- Links to other sites (wiki pages, playbook text and Agent answers) open in the system browser. A click
  asks first, showing the full address, and then calls the shell command `open_link`
  (`desktop/src-tauri/src/links.rs`), which runs `xdg-open` with the address as its only argument. It
  accepts only `http` and `https` addresses with a host, no user name or password and at most 2048 bytes,
  and answers a refusal as an error that the page shows (in the Agent panel as a problem message, elsewhere
  as an alert). Navigation inside the window to other sites stays refused. In a plain browser links behave
  as usual: wiki and playbook links open in a new tab, and Agent answers ask first.
- Run it from a checkout with `npm run desktop` (debug build). `npm run desktop:build` makes a .deb and an
  AppImage, but those builds are not supported: they need `pcbv` on PATH or `PCBV_SERVICE_DIR` set.

### The Arch package

`packaging/arch/` builds `pcbv-0.1.1-1-x86_64.pkg.tar.zst` with `makepkg` from a git ref of this checkout
(`PCBV_REF=branch=<name>`, or the tag `v$pkgver` by default), so the build never sees `node_modules`, notes or
uncommitted files. It needs the network (uv, cargo and npm download). Install it with `makepkg -si` in
`packaging/arch/`, or `sudo pacman -U pcbv-0.1.1-1-x86_64.pkg.tar.zst`; remove it with `sudo pacman -R pcbv`.

| Path | What |
|---|---|
| `/usr/bin/pcbv` | a shell script: runs the bundled Python with `-I -m pcbv` and sets `PCBV_APP_DIR` |
| `/opt/pcbv/python` | a standalone CPython 3.12 from uv, without its Tk GUI toolkit, with the locked service dependencies and the service |
| `/usr/share/pcbv/app` | the front end, without its tests |
| `/usr/bin/pcbv-desktop` | the shell, a release build, which finds `pcbv` on `PATH` |
| `/usr/share/applications/pcbv.desktop`, `/usr/share/icons/hicolor/128x128/apps/pcbv.png` | the Plasma menu entry and its icon |
| `/usr/share/licenses/pcbv/` | `LICENSE` and `THIRD_PARTY_LICENSES.md` |

The package has its own Python because Arch moves to a new Python version without warning, and an
environment built for one version breaks on the next. The cost is size, and libraries that only update when
the package is rebuilt. `-I` keeps your `PYTHONPATH`, `PYTHONHOME` and user site-packages out of the
service. `webkit2gtk-4.1`, `gtk3` and `xdg-utils` are required; `git`, `gitleaks`, `tio`, `picocom` and
the sigrok tools are optional dependencies. Stored assistant keys use the Secret Service (KWallet on
Plasma). Your boards (`~/hw`) and settings (`~/.config/pcbv`) are never part of the package.

Packages (once): `sudo pacman -S --needed rust webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator librsvg xdotool`.

## First start

While the saved `welcomed` setting is false and there are no boards, the empty-board panel shows a Welcome card
instead of "No boards yet". It explains the app in Guided (Expert shows one short line), shows the data folder, and offers
**Start the tutorial** (primary, with "About 20 minutes. No hardware needed."; it reads **Resume the tutorial (step N of
18)** while one is in progress and is gone once it is finished), **Create my first board** (focus goes to the name box), **Read Start here** and **What you need** (each brings up the panel area and opens that wiki page,
since the wiki lives there; the wiki's Back button then returns to the Welcome) and two optional buttons that open
Settings with focus on the git or assistant switch. The bench check lists whether you are in the `uucp` group and
whether `sigrok-cli`, the FX2 analyzer firmware and `gitleaks` are installed, each with a text mark and, when
missing, the command to run; **Check again** reads it again. **Skip**, or opening any board, saves `welcomed: true`; Skip
also saves `tutorial: skipped` when the tutorial was never started, so the app does not offer it on its own again.
The card makes no request outside the service. Settings, General, has the same bench check and **Show the welcome
again**, which always shows it and does not change `welcomed`. With a board open, the Welcome takes the board panel's
place while the board stays connected (a wiki page opened from the Welcome shows the panels live), the board list reads
"Choose a board", and **Back to my boards** (in place of Skip) or picking a board reopens it. An install that already
has boards never sees the Welcome on its own.

In the Playbook panel, **Reopen step** clears one step's done mark. **Start this playbook over**, at the bottom of the
panel once a step is done or a box is ticked, asks in the panel first and then clears every done mark and tick in that
playbook; what was written under Write down is kept.

## The tutorial

**Find the UART** is a guided tutorial of 18 steps in five chapters (Find, Measure, Connect, Get in, Verify): from an
unlabelled header on a board photo to a shell on the board's console, a matching logic capture and an exported report.
It uses the real panels on a practice board, kept apart from the user's own boards (see Practice board in
`SERVICE.md`). Chapter 1 (steps 1 to 4) zooms in, marks the header, labels it J4 and checks its shape; chapter 2
(steps 5 to 8) finds ground, the supply, TX and RX with a simulated multimeter; chapter 3 wires the adapter across
(step 9) and opens the console on the virtual board (steps 10 and 11); chapter 4 reads the boot text, stops at U-Boot
and boots to a shell (steps 12 to 14); chapter 5 decodes the practice capture, compares it with the console recording,
writes the header down and exports a report (steps 15 to 18).

- **Entry.** The Welcome's **Start the tutorial**, Settings, Tutorial (**Start the tutorial**, **Resume the tutorial
  (step N of 18)**, and **Start the tutorial again**, which asks "Your practice board is cleared. Your own boards are not
  touched." and then rebuilds the practice board), and a line at the top of the Start here wiki page. The progress is the
  settings `tutorial` and `tutorialStep`; the board format does not change.
- **The screen.** A fixed layout, never saved as a workspace: the panels the step needs on the left and in the centre
  (with the Wiki as a tab beside the photo, so the "Read more" link has somewhere to open) and the coach panel,
  380 px wide, on the right. Panels that were in their own windows come back first and return to their windows when the
  tutorial ends. The coach shows the chapter stepper, "Step N of 18", the step in at most three sentences, **Your task**
  (a list that ticks as the work is done), a hint when a typical mistake is seen, **Why this step** and a footer with
  **Back** and **Continue** (off until the task is done; then announced as "Step done." and taken by Enter). With the
  assistant setting on, a fold-out "Ask the assistant (example)" under the task list shows a made-up question and
  answer for the step; no question is sent to a model, and the Ask buttons in the panels are hidden while the tutorial
  runs.
- **The ring.** The control the next open task needs carries a steady ring (`tutorial-target`, in `--focus`), and
  Continue carries it once the step is done. When the control is in a panel that is a tab and not showing, the tab
  carries the ring instead. The control is scrolled into view when the target changes, once; focus does not move. A
  target that is missing, hidden or disabled gets no ring. The ring is visual only: the step text names the panel and
  the place of the control for screen-reader users.
- **Locked means inert.** While it runs, the top bar is `inert` (cannot be clicked, focused or read out) and dimmed,
  except **Leave tutorial**; panels the step does not need are put away, the Panels menu and its shortcut, dragging and
  the region menus do nothing, the dock does not attach a put-away panel,
  and Guided is forced (Expert comes back afterwards). Every board change goes through
  `core/tutorial/policy.js` before it is sent; a refused one is not sent and the coach says "Not needed for this step."
  A mistake inside the task is allowed, with a hint: a label other than J4 is saved, and Continue stays off.
- **The bench.** The app has no instrument and a pty has no pins, so steps 5 to 7 draw a multimeter in the coach and
  step 9 an adapter wiring figure; both are small models in `core/tutorial/bench.js` (pure, with an injected clock and
  random source). The meter has two modes (Continuity, DC volts), a board that is plugged in or not, **Power cycle**,
  and a red probe that follows the pin selected in the Header panel (or the Pin 1 to 4 buttons). On the practice board
  pin 4 beeps against the power jack's shell, pins 1 and 3 read a steady 3.30 V and 3.28 V, and pin 2 reads 3.30 V
  except for a jumpy 2.0 to 3.3 V for three seconds after a power cycle; a continuity test on a plugged-in board shows
  "Unplug the board first". **Record reading** stores what the meter shows on the probed pin of J4 as an ordinary
  `pin/readingAdded` event (source `tutorial`), so the evidence ends up on the board. The wiring widget has one select
  per adapter line (VCC, TXD, RXD, GND: a pin of J4 or Open) next to a figure of the wires. The bench is not board data:
  it lives in memory, starts fresh with each start of the tutorial, and each step sets the state it needs on entry
  (a step after the wiring starts with the adapter wired correctly). The meter redraws on its own, without redrawing
  the step, while pin 2 is jumpy, and its polite line speaks only when a steady reading changes.
- **The console steps.** Step 10's coach has **Start the virtual board**, which runs the same action as the Console
  panel's own button (that one is hidden while the tutorial runs). It is offered again on steps 11 to 14 when the
  virtual board is not running, so a resume or a Back never strands the person. While the tutorial runs the Console's
  port list shows the virtual board's port only, and its speed select starts at 9600 on step 10 (so the first thing
  seen is noise) and at 115200 on steps 12 to 14; the speed is applied once, never over a choice the person made,
  and the speed from before the tutorial comes back once the session has closed. The Console's **Detect** button is hidden and
  refused for the whole tutorial, because step 11 teaches finding the speed by trying them. The Console reports the session, the board's text,
  the chosen speed, the lines sent and the virtual board's state (`noteConsole`); `core/tutorial/consolefacts.js`
  keeps them as facts and derives every result from text the board sent: a prompt counts only at the start of a line,
  and the board echoes typed characters after its own prompt, so typing a prompt reaches nothing. Noise at a wrong
  speed is counted by its non-ASCII characters (`sawGarble`), and the board's text counts as a banner, a flash chip
  line, a prompt, `printenv` output or a shell command only when it arrived at 115200. Console input is locked until
  step 13, so step 12 is for reading: it asks which chip holds the firmware (three fixed choices, enabled once the flash
  line has printed) and is done when `25Q128` is chosen; a countdown that ran out on step 13 gets a hint to disconnect and connect again.
- **The logic steps.** The Logic panel's import is hidden and refused for the whole tutorial (the practice capture
  is the only one), decoding is open on steps 15 and 16 and comparing on step 16. What the lessons need is read from the
  capture the service saved (`decoded` at 115200 with at least 20 bytes and no framing errors; `compare.ratio`), so it
  survives a reload. A comparison matches at 0.8 or more: the practice capture was recorded without anyone touching
  the board, so its countdown ran out, and a console recording that stopped the countdown scores about 0.85 against it,
  while a recording made at the wrong speed scores near 0. The first difference shown is the moment the key was pressed.
- **Export.** Exporting is allowed on step 18 only, and the step is done when the Board panel reports a finished export.
- **Cleaning up.** Leaving or finishing closes the Console session on the practice board (an open session would make
  Start again refuse) and stops the virtual board only if the tutorial started it; one started from a terminal stays.
  It waits at most three seconds for the service; the calls go on in the background.
- **Leave and resume.** **Leave tutorial** (top bar) or Esc in the coach asks inline, naming the step to resume at, and
  Stay is the default; a second Esc leaves. Leaving restores the earlier layout, board and Guided/Expert level and keeps
  the step. Reloading the window, or restarting the service under it, goes straight back in at the saved step; a fresh
  launch offers Resume in the Welcome and Settings instead.
- **Finish.** The finish page lists what was done and offers **Create my first board**, What you need and Your first
  live board, saves `tutorial: done` and stops the virtual board. The list shows what the facts show. Console results
  are read back from the board's recordings on each start (the newest 20 serial captures, the first 256 KiB of each,
  compared and counted but never shown), and logic results from the capture, so after a reload only step 12's answer
  and step 18's export are asked again.

`pcbv demo` stays on the command line for screenshots and the demo video; the app no longer has a button for it.

## Practice without hardware

The Console panel has **Start the virtual board**
under the port list: it runs the practice board on this computer, refreshes the port list and selects "Virtual
board (pcbv vdev)". Connect at 115200 baud to watch it boot. **Stop the virtual board** appears for a board the app
started; one started from a terminal is listed but left alone. Both buttons are disabled while a console session is
open, and the virtual board ends when the app's service does.

## Pinning windows to monitors (KWin)

Wayland does not let apps place their own windows. `pcbv kwin-rules` writes a `.kwinrule` file
that pins windows to monitors by their exact titles:

```
pcbv kwin-rules main=0 console=1 timeline=1 --maximize
```

Import it in System Settings, Window Management, Window Rules, Import. Monitors are numbered from
0 in KWin's order. pcbv never changes the KWin configuration itself.

## Terminal panel

The Console confirmation names the board, port and speed and is bound to the active capture. The
Terminal panel is a normal shell without the Console's command check.

The Terminal panel is xterm.js connected to a shell the service runs on a pty in the board folder,
captured like `pcbv shell`. xterm.js is vendored in `app/vendor/xterm`; `npm run vendor` refreshes
it after `npm update`.

## AGENTS.md

While the assistant setting is on, `pcbv new` (and a board created in the app, and `pcbv demo`) writes an `AGENTS.md` into the board folder: the briefing for coding agents run in a
Terminal panel (folder layout, how to record findings, safety rules, firmware text is untrusted,
secrets). `pcbv agents-md <board>` adds it to older boards and never replaces one you edited unless
you pass `--force`. With the assistant off, a new board gets no `AGENTS.md`, and `pcbv agents-md` and
`pcbv fake-model` say the assistant is off, name the Settings dialog as the place to turn it on and exit with 1.

## GitHub backup

Settings, Git, puts a guide in front of the remote step: create an empty private repository, then log in with the
GitHub CLI (`gh auth login`) or an SSH key. Guided shows the steps; Expert shows one line and the link to the wiki
page Back up to GitHub. The dialog says that for a github.com address the step asks GitHub, without logging in,
whether the repository is public, and a public one is refused. After the address is set the step checks that git can
read the repository and shows git's last line with a hint when it cannot. That request, to api.github.com, is made only when
the remote step runs with a github.com address; it carries no token and no board data. The link to create a
repository opens in the system browser after asking, like the links in the wiki.

## Assistant setup

The Agent panel has a switch for the profile that answers: **Local** and the two cloud slots, shown by the name the
user gave them (Quick and Thorough until renamed). A line under the switch names the slots that have no server address
yet, and those buttons are shown muted. Arrow keys move
between them. Settings, Assistant, edits the same profile and has a **Name** field for the cloud slots (up to 24
characters). Settings, Assistant, shows a guide for the profile being edited: for the cloud slots, where to get an OpenRouter key
and that questions are paid per use; for Local, the Ollama install commands; for every profile, the SSH tunnel to
use for a model server on another machine (an address off this computer must be `https://`). Guided shows the steps;
Expert shows one line and the link to the wiki page Set up the assistant. **Test this profile** sends one short
question to the saved settings of the profile, with no board data, and shows the result in plain words. **Effort per
question** sets how many steps the assistant may take: Normal up to 8, Deep up to 24 with longer answers
(Guided explains the cost). When the system keyring is not available or locked, the key field is disabled and the dialog says how to open KWallet.
