# Playbooks

A playbook is a YAML file that leads you through one job on a board, step by step. The app shows
it in the Playbook panel, checks your progress against what is recorded on the board, and stores
that progress on the board itself.

## Where they live

- Built in: `service/src/pcbv/playbooks/` in this repo.
- Your own: `~/hw/playbooks/` (the `playbooks/` folder next to the boards root). A file there with
  the same `id` as a built-in replaces it, so you can reword or extend a playbook without touching
  code. Files are read on every app load.

Files sort by name, so prefix them `01-`, `02-` to set the order. A file with a mistake is listed at
the top of the Playbook panel with the reason, and the other playbooks still load.

The text a person reads in a built-in playbook (title, summary, and each step's title, `why`, `do`,
`done_when`, gate texts, ask labels and check texts) is plain English: short sentences, one
instruction per sentence, in the imperative.

## Format

```yaml
id: find-uart                  # lowercase letters, digits, dashes
version: 1
title: Find the UART
summary: One line shown under the title.
requires: [open-and-photograph] # playbooks that should be finished first (shown as a note)

steps:
  - id: ground
    title: Find ground with continuity, unpowered
    why: |                     # Markdown: why this step matters
      ...
    do: |                      # Markdown: what to do, usually a numbered list
      1. ...
    gates:                     # things to confirm before the step can be completed
      - id: unplugged
        text: The board is unplugged.
        destructive: false     # true: enforced in Expert mode too
    ask:                       # short answers stored with the step
      - id: soc
        label: SoC marking
        placeholder: "ARC7621"
        required: true         # default true
    checks:                    # evaluated live against the board
      - kind: pin_role
        roles: [GND]
        text: A pin is marked GND.
    done_when: You know which pin is ground.
    wiki: [multimeter, ground] # wiki pages shown as "Read more" links (see docs/SERVICE.md, Wiki)
```

Unknown keys are errors, so a typo like `gate:` instead of `gates:` cannot silently drop a safety
point. Markdown supports paragraphs, `-` and `1.` lists, `**bold**`, `*italic*` and `` `code` ``.

## Check kinds

| kind | parameters | passes when |
|---|---|---|
| `photos` | `min` (1), `side` (front, back, detail, other) | at least `min` photos; with `side`, only photos that have that side (older boards) |
| `meta` | `field` | that board detail (for example `device`) is filled in |
| `markers` | `min` (1) | at least `min` markers are drawn |
| `pin_role` | `roles` | some pin has one of these roles |
| `reading` | `mode` (dc, ohm, continuity), `powered`, `min`, `max`, `role`, `count` (1) | at least `count` pins have a reading matching all given filters; `role` limits it to pins with that role |
| `uart_header` | | one header has GND, TX and RX marked |
| `capture` | `seen`, `seen_any`, `baud`, `min_bytes` | a console session recognised all of `seen` and at least one of `seen_any`: `bootloader`, `autoboot`, `uboot-prompt`, `env` (printenv output), `help`, `kernel`, `shell`, `login` |
| `logic` | `decoded`, `baud`, `min_bytes`, `seen`, `seen_any`, `compared`, `min_ratio` (0 to 1) | an imported logic analyzer capture matches. With no parameters any imported capture passes. The other parameters look at what was decoded on one of its channels (`seen` and `seen_any` use the same names as `capture`), and `compared` or `min_ratio` also needs a comparison with a console capture for that same channel |

What a console session recognised is recorded on its capture by the service (see `docs/SERVICE.md`, Serial consoles).
Readings come from `pcbv measure` (see `docs/SERVICE.md`). An `OL` reading has no value, so it never
satisfies `min` or `max`.

## Guided and Expert

One setting for the whole app, switched in the header bar and saved per machine
(`~/.config/pcbv/settings.json`, see `docs/SERVICE.md`). Board files do not depend on it.

- **Guided** (default): steps open one at a time. A step can be marked done once its gates are
  confirmed, its required questions answered and its checks pass. The first wiki page a step names
  is shown under it as an open "Background" section, callouts on the photo show full labels, and
  the panels show their usage hints.
- **Expert**: every step is open. "Why" and "What to do" are folded behind Details, only gates
  marked `destructive: true` are shown and they still block, questions are optional, and a failing
  check is a warning. Wiki pages stay links, callouts shrink to dots that show their label on hover,
  usage hints are hidden, and the assistant answers tersely.

Boards from before this setting may carry `meta.mode`; the app ignores it.

These rules are enforced by the app. Playbooks 1 and 2 have no destructive steps. When later
phases add commands that change hardware, those gates are enforced by the service as well.

## Progress

Progress is board data, stored with `playbook/updated` events in the board journal:
`project.playbooks[<id>].steps[<step>] = { gates, answers, done }`. It shows up in the Timeline,
survives restarts, and goes into git with `pcbv sync`.

**Reopen step** clears one step's done mark and keeps its ticks. **Start this playbook over**, at the
bottom of the panel once a step is done or a box is ticked, asks inline first and then clears every done
mark and tick in the playbook, one `playbook/updated` event per step with progress. What was written
under Write down (`answers`) is kept.
