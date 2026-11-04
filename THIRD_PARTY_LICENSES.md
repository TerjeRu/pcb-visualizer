# Third-party licenses

PCB Visualizer is MIT licensed. This file lists the third-party software it uses.

## Bundled in the repository

| Software | License | Where |
|---|---|---|
| xterm.js and addon-fit | MIT | `app/vendor/xterm/` (license file included) |

## Python service

The service and the Arch package contain these packages from PyPI.

| Package | License |
|---|---|
| annotated-doc | MIT |
| annotated-types | MIT |
| anyio | MIT |
| cffi | MIT-0 |
| click | BSD-3-Clause |
| cryptography | Apache-2.0 or BSD-3-Clause |
| fastapi | MIT |
| h11 | MIT |
| idna | BSD-3-Clause |
| jaraco-classes | MIT |
| jaraco-context | MIT |
| jaraco-functools | MIT |
| jeepney | MIT |
| keyring | MIT |
| more-itertools | MIT |
| opentelemetry-api | Apache-2.0 |
| pillow | MIT-CMU |
| pycparser | BSD-3-Clause |
| pydantic | MIT |
| pydantic-core | MIT |
| pyserial | BSD-3-Clause |
| pyyaml | MIT |
| secretstorage | BSD-3-Clause |
| starlette | BSD-3-Clause |
| typing-extensions | PSF-2.0 |
| typing-inspection | MIT |
| uvicorn | BSD-3-Clause |
| websockets | BSD-3-Clause |

The Arch package also contains a standalone CPython 3.12 (python-build-standalone, PSF-2.0). `LICENSE` and
this file are installed in `/usr/share/licenses/pcbv/`.

## Desktop shell

The desktop shell uses Tauri 2 (MIT or Apache-2.0), serde and serde_json (MIT or Apache-2.0), and the
crates they need. Most of these crates are MIT, Apache-2.0 or both. The others use Unicode-3.0, Unlicense,
Zlib, BSD-3-Clause, ISC, 0BSD, CC0-1.0 or Apache-2.0 WITH LLVM-exception. Five crates use MPL-2.0 and are
used unmodified: cssparser, cssparser-macros, selectors, dtoa-short and option-ext.
`desktop/src-tauri/Cargo.lock` lists every crate and version.

The shell links to the system's WebKitGTK and GTK 3 libraries (LGPL-2.1 or later), which Arch installs as
packages.

## Programs that the app uses but does not include

You install these yourself. They run as separate programs.

| Program | License | Use |
|---|---|---|
| git | GPL-2.0 | board history and sync |
| gitleaks | MIT | secret scan before each commit |
| sigrok-cli, PulseView | GPL-3.0 or later | record logic captures |
| sigrok-firmware-fx2lafw | GPL-2.0 or later, LGPL-2.1 or later | firmware for FX2 logic analysers |
| tio, picocom | GPL-2.0 or later | serial terminals |
| xdg-utils | MIT | open links in the system browser |

## Development tools

Tests, lint and builds use pytest, ruff, coverage, jsdom, eslint and the Tauri CLI. These tools are not
part of the package.
