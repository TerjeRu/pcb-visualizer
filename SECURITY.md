# Security

PCB Visualizer runs on your own machine and listens on loopback only. Every API call except a health check needs a
per-session token, except exchanging a one-time login code for it; the front end's own files, which hold no board
data, are served without one. Windows are opened with a code that works once and expires after 60 seconds. A code
is still a credential while it lives, and it does not protect against another process running as your user.
The assistant sends model servers on other machines only over https, never follows a redirect, binds a stored key
to the server's scheme, host and port, and sends photos only to profiles you ticked.
Boards, logs and notes can come from untrusted devices, and the optional assistant reads them, so the project treats
that text as hostile input.

## Reporting a problem

Please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability")
rather than a public issue. Include the version, steps to reproduce and what you expected. Expect a first answer
within a week; this is a one-person project.

Things worth reporting: a way to reach the service from another host or web page, a way to make the assistant run a
command without the person approving it, a key written to disk or to a log, HTML or script injection from a board
or a capture, and a path outside a board folder being read or written.

## Not covered

The tool does not protect a board you own from physical attacks, and the assistant's answers can be wrong.

Board file reads, creation, replacement and cleanup use directory-relative no-follow operations.
The service refuses unsupported storage versions before repair or locking and rejects incompatible
mutation clients before board access. This does not isolate files from another process running under
the same OS identity. Durability relies on normal filesystem fsync guarantees. Failed rollback freezes
board writes; recovery copies and uncertain-operation guidance are described in
[the service contract](docs/SERVICE.md#durability-and-recovery).

Console command checks cover a list of known dangerous commands and cannot identify every possible
hardware write. Console writes and command approvals require the active capture identity, so a
reconnection cannot redirect an earlier approval. The Terminal panel is an unrestricted shell.
