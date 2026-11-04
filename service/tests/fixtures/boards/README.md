# Sample boards

Small board folders that `tests/test_board_fixtures.py` copies to a temporary directory and opens. The
tests never regenerate them and never write into this folder.

- `current/`: journal 2 and snapshot 2. Six events: project created, device set, one photo, one marker
  with its header, one pin, and one `board/batch` of three child events. `assets/front.png` is an 8 x 6
  green image generated with the standard library for this fixture; it has no copyright holder. The
  `.pcbv/` cache folder was removed, since the service rebuilds it.
- `unversioned/`, `v1/`, `future-v3/`: the same journal and snapshot with `journalVersion` and
  `schemaVersion` removed, set to 1, and set to 3. The service refuses all three.
- `snapshot-v1/`: the `current` journal (version 2) with the snapshot's `schemaVersion` set to 1. The
  service refuses it on the snapshot check.

`current/` was made once with `Board.create` and `Board.apply`, using actor `fixture`. The others were
derived from it by rewriting the version fields. Replace them only by a deliberate change to the board
format, together with the contract in `docs/SCHEMA.md`.
