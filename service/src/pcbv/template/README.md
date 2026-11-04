# Hardware notebook

Private data repo for PCB Visualizer. Code lives in the pcb-visualizer repo; this holds what was learned.

- `boards/<slug>/`: one folder per board (`project.pcb.json`, `journal/events.jsonl`, captures, notes).
- `wiki/`: knowledge base in Markdown.
- `library/datasheets/`: datasheet notes (PDFs stay local).
- `playbooks/`: playbook definitions.
- `journal/`: daily cross-board journal.

Sync with `pcbv sync`. Every commit passes the guard in `.githooks/pre-commit`: no `dumps/`,
`extracted/` or `.pcbv/`, nothing over 5 MB, and a gitleaks secret scan. After a fresh clone,
run `pcbv repo init` once so git uses that hook.
