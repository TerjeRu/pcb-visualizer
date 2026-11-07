# Project file schema (v1)

A board is a folder that the service owns (see `docs/SERVICE.md`). The journal is the source of
truth; `project.pcb.json` is the snapshot of the state it produces, in the format described here.

```
my-router/
  journal/events.jsonl      append-only event log, the source of truth
  project.pcb.json          snapshot of the current state
  assets/photos/<id>.jpg    photos, upright and without metadata
  assets/photos/originals/  the uploaded originals (kept out of git by the data repo)
  captures/                 serial, shell and logic captures
  analysis/findings.md      notes: yours as you write them; the assistant's under "## Assistant finding (unverified): title"
```

The JSON is written with two-space indentation, a trailing newline and a
stable key order, so `git diff` shows real changes only.

## Design rule: physical and abstract data are separate

| Object      | Knows about                          | Does not know about        |
|-------------|--------------------------------------|----------------------------|
| `assets`    | file path, pixel size                | markers, pins              |
| `markers`   | which asset, where on it (pixels)    | pin count, labels          |
| `schematics`| grid size, numbering, pins, labels   | photos, coordinates        |
| `components`| which asset, bounding box            | everything else            |

A marker links one photo location to one schematic through `schematicId`.
You can re-shoot a board, add the new photo, move the markers, and every
pin label survives untouched. Two markers (front and back photo of the same
header) may point at the same schematic.

## Top level

```jsonc
{
  "format": "pcb-visualizer-project",   // required, identifies the file
  "schemaVersion": 2,
  "meta": { ... },
  "assets": [ ... ],
  "markers": [ ... ],
  "schematics": [ ... ],
  "components": [ ... ]
}
```

Unknown top-level keys and unknown keys inside objects are preserved on
load and save. External tools can add data the UI does not render yet.

## `meta`

| Field      | Type   | Notes                                   |
|------------|--------|-----------------------------------------|
| `id`       | string | `prj_…`, stable for the project's life   |
| `name`     | string | shown in the title bar                  |
| `device`   | string | free text, e.g. "Acme Nimbus rev B" |
| `notes`    | string | free text                               |
| `created`  | ISO    |                                         |
| `modified` | ISO    | set on every save                       |

## `assets[]`

| Field    | Type   | Notes                                              |
|----------|--------|----------------------------------------------------|
| `id`     | string | `img_…`                                            |
| `kind`   | string | `"image"` (reserved for future kinds)              |
| `path`   | string | relative to the project folder, e.g. `assets/x.jpg`|
| `label`  | string | tab name in the UI                                 |
| `side`   | string | optional, kept for older boards: `front`, `back`, `detail`, `other` |
| `width`  | number | natural pixel width of the image                   |
| `height` | number | natural pixel height                               |
| `original` | string | service uploads only: the full-size original under `assets/photos/originals/`, kept local (git-ignored) |
| `rotation` | int    | optional: 0, 90, 180 or 270, the clockwise quarter turns made in the app; the original on disk is never turned |

Photos added through the service live at `assets/photos/<id>.jpg`: upright, at most 2560 px on the long side, no EXIF. `path`, `width` and `height` describe that copy. A turned photo gets a new copy at `assets/photos/<id>-<hex>.jpg`; the earlier copies stay in the folder.

## `markers[]`

All coordinates are **pixels in the photo's committed copy** (origin top left; the asset's `width`
and `height`). The assistant works in percent of the photo and converts.

| Field         | Type   | Notes                                          |
|---------------|--------|------------------------------------------------|
| `id`          | string | `mk_…`                                         |
| `assetId`     | string | photo this marker sits on                      |
| `schematicId` | string | linked abstract schematic                      |
| `shape`       | string | `box` or `crosshair`                           |
| `x`, `y`      | number | box top left, or crosshair center              |
| `w`, `h`      | number | box only                                       |
| `label`       | string | designator as printed on silkscreen, e.g. `J4` |
| `color`       | string | hex color of the marker                        |

## `schematics[]`

| Field       | Type   | Notes                                                        |
|-------------|--------|--------------------------------------------------------------|
| `id`        | string | `sch_…`                                                      |
| `kind`      | string | `header` (reserved for `ic`, `testpad` etc.)                 |
| `name`      | string | e.g. "UART console"                                          |
| `rows`      | int    | 1 to 64                                                      |
| `cols`      | int    | 1 to 64                                                      |
| `pitch`     | number | millimetres, informational                                   |
| `numbering` | string | `row` (1 2 3 / 4 5 6), `column` (IDC: 1 3 5 / 2 4 6), `u` (DIP: 1 2 3 / 6 5 4) |
| `rotation`  | int    | 0, 90, 180, 270; display only, to match the photo orientation |
| `notes`     | string |                                                              |
| `pins`      | array  | sparse: only pins with data are stored                       |

### `pins[]`

| Field   | Type   | Notes                                                 |
|---------|--------|-------------------------------------------------------|
| `index` | int    | 1-based pin number under the chosen numbering         |
| `role`  | string | `GND`, `VCC`, `3V3`, `5V`, `TX`, `RX`, `RST`, `BOOT`, `SWDIO`, `SWCLK`, `TCK`, `TMS`, `TDI`, `TDO`, `TRST`, `NC`, `CUSTOM` or empty |
| `label` | string | free text, shown in the grid                          |
| `color` | string | six-digit hex or empty for an unset pin colour                                                   |
| `note`  | string | measurements, observations                            |
| `readings` | array | multimeter readings, oldest first (written by `pcbv measure` or the pin form) |
| `guess` | object | optional AI guess from a photo: `{ "role", "confidence": "high" \| "medium" \| "low", "evidence", "by", "at" }`. Never the pin's `role`; the person sets that |

Readings are appended through `pin/readingAdded`, so concurrent writers do not replace each other's lists.

Each reading: `{ "ts": ISO, "mode": "dc" \| "ohm" \| "continuity", "value": number or null for OL, "unit": "V" \| "Ω", "text": "3.29 V", "powered": bool, "source": "cli" \| "app" \| "tutorial" }`. Readings from the pin form carry `"app"`, and readings from the tutorial's simulated meter carry `"tutorial"`.

Pins whose index is beyond `rows × cols` (after shrinking a grid) are kept
in the file and hidden in the UI, so a mistaken resize loses nothing.

## `captures[]` (written by the service)

One entry per console session: `{ "id": "cap_…", "kind": "serial", "path": "captures/serial/…log", "port", "label", "byPath", "baud", "started", "stopped", "bytes", "reason", "seen": [...] }`. `seen` lists what the session recognised (bootloader, autoboot, uboot-prompt, env, help, kernel, shell, login). The log file holds the raw bytes exactly as received. Clients cannot write these events.

## `annotations[]` (callouts)

Optional. Labels on a photo, each a dot on a part, a leader line and a text label. Coordinates are
pixels in the photo, like markers.

| Field    | Type   | Notes                                                   |
|----------|--------|---------------------------------------------------------|
| `id`     | string | `an_…`                                                  |
| `assetId`| string | photo it sits on; removed with the photo                |
| `x`, `y` | number | the point on the part                                   |
| `lx`, `ly` | number | where the label is attached                           |
| `text`   | string | at most 200 characters                                  |
| `wiki`   | string | optional wiki page name, for "Open wiki page"           |
| `guess`  | object | optional, for a label the assistant suggested: `{ "confidence", "evidence", "by", "at" }`; set to `null` once the person has checked it |

Written with `annotation/added`, `annotation/updated` and `annotation/removed` events.

## `playbooks` (progress)

Optional. Per playbook id: `{ "steps": { "<step id>": { "gates": {id: bool}, "answers": {id: text}, "done": ISO or null } } }`,
written with `playbook/updated` events. See `docs/PLAYBOOKS.md`. Older boards may carry `meta.mode`
(`"guided"` or `"expert"`); Guided and Expert is now an app setting, and the app ignores this field.

## `components[]` (written by external tools)

Reserved for vision pipelines and other tools. The UI renders these as
dashed boxes on the photo and never edits them.

```json
{ "id": "cmp_…", "assetId": "img_…", "class": "SoC", "label": "SoC",
  "bbox": [640, 350, 240, 240], "confidence": 0.97, "source": "my-model-v3" }
```

`bbox` is `[x, y, w, h]` in image pixels. An object `{ "x", "y", "w", "h" }`
is accepted too.

## Validation and storage versions

The service accepts exactly snapshot schema 2 and journal version 2. Boolean version values are
invalid. Unsupported development boards are refused without modification; recreate the test board
in a new folder with `pcbv new` or `pcbv demo`. There is no automatic migration or downgrade support.
See `SERVICE.md` for commit outcomes, recovery copies and protocol 2.

Coordinates and rotations must be finite numbers with absolute value at most 1,000,000. Widths,
heights and pitches must also be positive. Booleans, NaN and infinity are refused. Grid rows and
columns remain integers from 1 to 64; pin indices are integers from 1 to 1,000,000 and may survive a
grid shrink. Markers may extend past a photo edge. Component bounding boxes use the same coordinate
and length rules. Colours are exactly `#RRGGBB`, case insensitive. Unset pin colours may be empty.
The same item and reference checks apply to live events and external snapshot replacements.

A batch stores 1 to 256 ordinary event payloads in one `board/batch` record. It advances the sequence
once and applies the outer timestamp once. `proposalId`, when present, is service-owned batch metadata;
it is not a project field or a public event input. Storage warnings are also outside the project state.

## Backup and recovery

A board is one folder. Only `project.pcb.json` is derived: delete it and the next open rebuilds it from
the journal. Everything else in the folder is user data and belongs in a backup, including `.pcbv/`.
Do not delete `.pcbv/`: it holds your redaction list (`redact.txt`) and the saved copies of outside edits
in `.pcbv/recovery/`. `captures/`, `analysis/`, `dumps/`, `extracted/` and `AGENTS.md` are your own work
and are not in the journal.

- **Back up** by copying the whole board folder while the service is stopped, for example
  `cp -a ~/hw/boards/my-board ~/backups/my-board`. A copy taken while the service runs can end in the
  middle of a journal line; the service repairs that on open, but the line is lost. It can also catch the
  journal and the snapshot at different points, and changes made during the copy can then be missing from
  the restored board. On open the service always trusts the journal; sometimes it also keeps the old
  snapshot under `.pcbv/recovery/` and shows a recovery warning. Stopping the service first avoids all of
  this. To restore, put the folder back under the boards root with the same name.
- **A version error** such as `unsupported journal version 1 at seq 1; this service reads journal version 2`
  means the board was written by a different version of the format. The service refuses it before it
  changes anything, so the folder is exactly as you left it. There is no migration. Recreate the test board
  in a new folder with `pcbv new "Name"` (or `pcbv demo`), then delete the old folder yourself once you no
  longer need it.
- **A broken snapshot** needs no repair. If `project.pcb.json` is missing, or the service stopped before
  writing it, the next open writes it again from the journal. Outside edits that cannot be recorded are
  kept under `.pcbv/recovery/` and never deleted by the service.
- Sample boards for each case are in `service/tests/fixtures/boards/`; the tests open them on every run.
