---
name: parse-fmt-mlog
description: Browser-side FMT MLog parsing and flight-log visualization guidance. Use when modifying this repository's static GitHub Pages app, implementing or debugging `.bin` / `.mlog` parsing, adding charts or CSV/JSON exports, comparing behavior with the firmware Python parser, or validating MLog binary samples.
---

# Parse FMT MLog

## Workflow

1. Read `references/mlog-format.md` before changing parser behavior.
2. Treat `D:\AEROlab\Project\FMT\FMT-Firmware\utils\python_mlog_parser\parse_mlog.py` as the behavior reference when available.
3. Cross-check header and parameter layout with `D:\AEROlab\Project\FMT\FMT-Model\utils\log_parser\functions\mlog_parser.m`; it correctly reads `param_group.num_param` as `uint32`.
4. Keep all user log processing in the browser. Do not add a backend unless the user explicitly changes the deployment target.
5. Preserve GitHub Pages compatibility: static files should work from the repository root without a build step unless the project is intentionally migrated to a build tool.
6. After parser changes, run `npm.cmd test` from the repository root.

## Implementation Rules

- Parse from `ArrayBuffer` / `DataView`; do not convert binary logs to strings.
- Use little-endian reads for all integer and floating-point fields.
- Decode fixed-size names as UTF-8 up to the first `0x00`, then trim trailing whitespace.
- Use bus definitions from the file header to determine each frame payload length.
- Treat parameter parsing as best-effort. If a parameter type is unknown or the parameter section looks misaligned, keep parsed bus definitions, record a warning, and scan for frames from the parameter section start.
- Resynchronize by advancing one byte when a frame marker, message id, payload, or end marker does not match.
- Compute `delta_ts` per message id from a scalar field named exactly `timestamp` when present.
- Keep CSV export columns in the same order as bus elements, expanding vectors as `field[0]`, `field[1]`, then append `delta_ts`.

## Current Project Files

- `src/mlogParser.js`: parser, CSV export, and chart-series selection.
- `src/mavlinkFtp.js`: browser-side Web Serial MAVLink v1/v2 frame handling and MAVLink FTP directory operations.
- `src/app.js`: file upload, rendering, downloads, and canvas charts.
- `src/logCache.js`: IndexedDB cache for the most recent uploaded log; keep logs local to the browser.
- `test/smoke.test.js`: minimal synthetic MLog sample used as a regression test.
- `index.html` and `styles.css`: static UI for GitHub Pages.

## Validation

Use this command on Windows:

```powershell
npm.cmd test
```

Avoid plain `npm test` in PowerShell if script execution policy blocks `npm.ps1`.

For functional testing, upload a real MLog `.bin` file in the page and confirm:

- Header metadata appears.
- Message table shows nonzero frame counts for expected buses.
- At least one chart appears for changing numeric fields.
- CSV download opens with expected columns and row count.
