# Settings and privacy

The app has two optional features: the bench assistant and git. Both are **off** on a fresh install. When
both are off, nothing leaves your computer. The rest of the app works the same: photos, headers,
playbooks, the console, logic captures, the wiki and export. This page says what each setting does and
what leaves the computer when you turn it on. To open Settings, use the button in the top bar.

## General

- **Guidance.** The Guided / Expert switch in the top bar sets it. Guided shows explanations and hints.
  Expert hides them. Both modes ask a safety question before a destructive action.
- **Theme.** System follows your desktop. Light and Dark force one theme.

Settings belong to this computer. The app keeps them in `~/.config/pcbv/settings.json`, not in your
boards.

## Assistant

The assistant answers questions about a board. It also suggests labels, pin roles and console commands. It
only suggests. After you click, the app types a command into the console. The guesses of the assistant stay
marked as unverified until you measure.

**Off (the default).** The board screen has no Agent panel and no Ask buttons. The service refuses every
assistant request. The `pcbv new` command does not write an `AGENTS.md` into new boards. Guesses that a
board already stores stay in the data. The app shows them as ordinary values marked unverified.

**On.** Each question goes to the model server that you chose for the profile. It goes with the data that
the assistant looks at to answer it: board details, headers and pins, readings, notes, and console and
capture text. *Effort per question: Deep* sends no new kind of data. It sends more of the same kind of
request. The app sends photos only for a profile where you ticked *Send photos to this model*. Choose the
server yourself:

- A cloud server (OpenRouter, the DeepSeek API) receives that data and may keep it under its own terms.
  Console captures can hold serial numbers, MAC addresses and passwords. Read
  [Method and ethics](method-and-ethics) before you ask about a raw boot log.
- A model on your own machine or network (for example Ollama) keeps the data there. An address must use
  `https://`, except for this computer (`localhost`, `127.0.0.1`, `::1`).

The app stores the key in your system keyring, never in a board or in the settings file. When you change
the server address, the app removes the stored key. This stops a key from going to a different server by
accident. [Set up the assistant](assistant-setup) explains how to get a key and how to use a local model or a
model on another machine. It also explains the *Test this profile* button. If you turn the assistant off, the app stops a
question that is running. It keeps your profiles, keys and earlier findings.

## Git

Boards are plain folders under the data folder (`~/hw` by default), whether git is on or not. Git adds a
history of changes to that folder.

**Off (the default).** The timeline shows no commits. The guidance does not mention git. The `pcbv sync`
command declines.

**On.** The data folder is a git repository with a commit guard. Before each commit, the guard scans the
changes with gitleaks. It blocks the commit when it finds a secret. The `pcbv sync` command commits
through the guard.

Nothing leaves the computer unless you set a remote address. If you set one, sync also pulls from it and
pushes to it. The remote then stores everything that you committed, including your notes and captures.
Before each push to a GitHub address, the app asks GitHub whether the repository is public. It does this
without a login. If the repository is public, or if GitHub cannot answer, the app pushes nothing.

Setup has five steps. The dialog shows them in order, with the result of each:

1. **Check tools.** `git` and `gitleaks` must be installed. If one is missing, the dialog shows the exact
   command to install it.
2. **Prepare the folder.** The app creates the repository, the commit guard and the ignore rules.
3. **Check photo originals.** An original photo can carry EXIF data, such as the GPS position where you
   took it. The ignore rules keep originals out of git. If they do not ignore the originals, git stays
   off.
4. **Set remote (optional).** Enter an address like `git@host:owner/repo.git` or
   `https://host/owner/repo.git`. The app refuses addresses with a user name or password in them. Use an
   SSH key or a credential helper. The app replaces an existing different remote only after you confirm.
5. **Test sync.** The app makes one commit through the guard. If you set a remote, it also pushes. If the
   guard blocks the commit, the dialog shows the message of the guard.

Step 4 also asks GitHub, without a login, whether the repository is public. The app refuses a public
repository. Then it checks that git can read the repository. [Back up to GitHub](github-backup) explains
how to create a private repository, how to log in and how to restore on a new computer.

Git switches on only when steps 1 to 3 pass. If you switch git off, or the assistant off, the app never
deletes data, keys or repository files.
