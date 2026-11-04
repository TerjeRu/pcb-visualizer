# Privacy

PCB Visualizer collects no data about you. It has no accounts, no telemetry, no crash reports and no
update check. The service listens only on this machine. Your boards, captures and notes are files on your
disk.

The service includes the `opentelemetry-api` package because FastAPI needs it. That package sends nothing
without an exporter, and PCB Visualizer installs no exporter.

## When data leaves your machine

Two features send data. Both are off until you turn them on.

- **Git sync** pushes your data repository to the remote that you set. Before each push to GitHub, the app
  asks the public GitHub API whether the repository is public. This request has no token and no board
  data. The app does not push to a public GitHub repository.
- **The assistant** sends the board data and logs for each question to the model server that you set. It
  sends photos only to a profile with "Send photos" selected. The provider of that server receives this
  data, and the provider's terms apply. You choose the provider, and you are responsible for that choice.

Model keys stay in the system keyring (KWallet or Secret Service). The app sends a key only to the server
of its profile.

Links to other sites open in your system browser.

## Downloads

Updates come from the package manager, not from the app. The package repository at
`pcb.lethio.com/arch` keeps no access log. Downloads from GitHub follow GitHub's terms.

## Redaction

The app does not change what you record. A board folder keeps passwords, keys and serial numbers as they
were captured, so you can keep secrets in your own boards.

Redaction applies to copies that you make for other people:

- `pcbv redact` writes a redacted copy of a board. It replaces credentials, private keys, serial numbers,
  MAC addresses and public IP addresses, and lists each replacement in `REDACTION.md`. You can add your own
  strings in `.pcbv/redact.txt` in the board folder.
- An export is redacted by default. For an export without redaction, clear **Redact credentials, serial
  numbers and addresses** in the Export section, or use `pcbv export --no-redact`.

The assistant does not redact. It sends board text as it is stored.

With git sync on, the commit guard refuses a commit that contains a secret that gitleaks finds. A secret
in a board can stay on your disk, but the app does not commit it. To commit such a value, add an allow
rule to `.gitleaks.toml` in your data repository. `pcbv repo init` does not overwrite that file.
