# Multi-Brand Printer Support

> **Phase 6C added (2026-04-20).** Klipper (Moonraker) connector complete — covers Voron and all Klipper-firmware printers. Prusa Link, Elegoo SDCP, Bambu, and Klipper are all fully supported.
>
> **Phase 6D added (2026-07-03).** OctoPrint connector complete — covers any printer running OctoPrint/OctoPi (Prusa, Ender, Voron, or otherwise), via OctoPrint's own REST API rather than the printer firmware's native protocol.

## Overview

The system was built against PrusaLink (Prusa's REST API). The `type` column on the `printers` table has always anticipated future brands. Phase 6 makes that column meaningful by introducing a **printer driver abstraction layer**.

The first non-Prusa target is the **Elegoo Centauri Carbon**, selected because:
- It's a capable FDM machine that would slot naturally into a mixed fleet
- Its community-documented SDCP protocol is well-understood (see external links below)
- Adding it exercises the full abstraction — protocol, auth, upload, and state mapping all differ from Prusa

See [ARCHITECTURE.md Section 13](../ARCHITECTURE.md#13-phase-6--multi-brand-printer-support) for the full spec.

---

## The Core Problem

PrusaLink is a REST API (HTTP polling). The Elegoo Centauri Carbon uses **SDCP — a WebSocket-based proprietary protocol**. They are fundamentally different communication models.

| Capability | PrusaLink | Elegoo SDCP |
|---|---|---|
| Status | `GET /api/v1/status` | WebSocket request/response on port 3030 |
| Upload | `PUT /api/v1/files/usb/{name}` | `POST /uploadFile/upload` (multipart) |
| Print trigger | `Print-After-Upload: 1` header | WebSocket command after upload |
| Auth | `X-Api-Key` header | None (LAN only) |
| File format | `.bgcode` / `.gcode` | `.gcode` only |

This means the poller and scheduler can't just swap a URL — they need to call different code entirely depending on printer brand.

---

## Canonical State Model

Both brands map their native states to a shared internal set. The rest of the system (poller events, scheduler logic, UI colors) never changes:

| Canonical | PrusaLink source | SDCP source |
|---|---|---|
| `IDLE` | `IDLE` | Code 0 |
| `PRINTING` | `PRINTING` | Codes 1, 13, 16, 18, 21 (several FDM startup states — see CHANGELOG) |
| `FINISHED` | `FINISHED` | Codes 3 (stopped) and 4 (complete) |
| `PAUSED` | `PAUSED` | Code 2 |
| `ERROR` | `ERROR`, `ATTENTION` | Not currently generated; reserved for confirmed fault codes |
| `OFFLINE` | Timeout | WebSocket unreachable |
| `UNKNOWN` | — | Unrecognised SDCP code; logged for classification, does not hold printer |

### Bambu status mapping (MQTT `gcode_state`)

`RUNNING`/`PREPARE` → `PRINTING`, `IDLE` → `IDLE`, `PAUSE` → `PAUSED`, `FINISH` → `FINISHED`.

`FAILED` needs disambiguation: Bambu reports a user-cancelled print (Stop pressed on the printer screen) as `gcode_state: FAILED` — the same state as a genuine failure — and keeps reporting it until the next print starts or the printer power-cycles. The driver tells them apart via `print_error`:

- `50348044` (`0x0300400C`) — cancelled by the user; sent for a few seconds after the stop, then resets to `0` while `gcode_state` stays `FAILED` → maps to **`STOPPED`** (scheduler cancels the job, printer held for operator sign-off)
- `0` — no active error code; a settled user cancel → **`STOPPED`**
- any other nonzero value — genuine firmware-detected failure → **`ERROR`**

Reference: ha-bambulab `pybambu/models.py` cancel handling. Without this, a Bambu stopped from its own screen shows a persistent false ERROR in the farm that decommission/recommission cannot clear (status always comes from the live MQTT report, not the DB).

### Bambu FTPS uploads

Uploads go to implicit FTPS on port 990 (user `bblp`, LAN access code) in passive mode. The printer's FTP server (vsftpd 3.0.5 on an H2D) requires the data connection to resume the control connection's TLS session and answers `522 SSL connection failed: session reuse required` otherwise. The driver's `openDataConnection` replaces basic-ftp's passive setup for this reason: basic-ftp wraps an already-open socket in TLS, and on Node 22 that socket does not offer the session, while a direct `tls.connect` does.

With a USB drive inserted on an H2-series printer, the FTP root is the drive. With no drive, the root lists as empty and uploads fail with `553 Could not create file`.

On a 553 the driver falls back to the file service on TCP 6000 (`server/drivers/bambu-tunnel.js`), which writes to internal storage (`emmc`), then starts the print with the URL `brtc://emmc/<name>`. Bambu Studio falls back in the same order. Bambu has not published this protocol: the implementation follows the notes at `ClusterM/open-bamboo-networking` and packet captures of Bambu Studio. Developer Mode is still required, because the print command is unsigned MQTT.

Validation status:

| Printer | FTPS with drive | Print started after FTPS | Port 6000 upload | Print started after port 6000 |
|---|---|---|---|---|
| H2D (first unit) | Validated | Validated | Printer refuses the TLS handshake, also from Bambu Studio (cause unknown) | Not possible |
| H2D (second unit) | Not tested | Not tested | Validated | Validated: printer accepted the command and began printing (completion not yet confirmed) |
| H2S | Not tested | Not tested | Validated | Validated: printer accepted the command and began printing (completion not yet confirmed) |

Other Bambu models have not been validated on either route.

### Bambu AMS mapping

The `project_file` command maps each project filament to a tray. The driver builds the mapping the way Bambu Studio does (`get_ams_mapping_result` in bambulab/BambuStudio `src/slic3r/GUI/SelectMachine.cpp`), implemented in `server/drivers/bambu-ams.js`:

- `ams_mapping` has one entry per project filament (the length of `filament_type` in `Metadata/project_settings.config`). The index is the filament id from `Metadata/slice_info.config` minus 1, the value is the tray (`ams_id * 4 + slot_id`), and -1 marks a filament the plate does not use. A plate printing filament 2 of 2 sends `[-1, tray]`.
- `ams_mapping2` has the same indexes as `{ ams_id, slot_id }` objects, with 255/255 for unused filaments.

A G-code's `ams_slot` is one of three filament sources: `-1` the external spool, `0` and up a fixed tray, or `-2` **match from AMS**. With match from AMS there is no starting slot: the driver picks the tray holding the plate's filament type from the sliced file, preferring the same color, and throws `AMS_NO_MATCH` if none has it or `AMS_NO_FILE_INFO` if the file does not say. An Auto filament printer (docs/filaments.md) that matched the part's required material and color through a particular spool is sent that spool's slot by the scheduler instead, which the driver then checks the same way as a fixed slot.

A fixed slot is a starting point, not a guarantee. Before uploading, the driver checks the printer's live AMS report. A dispatch right after recommission runs on a new MQTT connection, so the driver waits up to 20 s for the first report and throws `AMS_UNKNOWN` if none arrives. The configured tray is used only when the report shows the plate's filament type in it. An empty tray, or one missing from the report, does not count. Otherwise the driver picks a tray with that type, preferring the same color, and logs the change. If no tray has the type, `uploadAndPrint` throws `AMS_NO_MATCH`. Both errors happen before any transfer, and the scheduler's upload-failure path holds the printer. A plate that uses more than one filament throws `AMS_MULTI_FILAMENT`, because a G-code carries a single slot. A file with no slice info falls back to `[slot]`.

Without a correct mapping the printer pauses right after the print starts with HMS 0700_8012, "Failed to get AMS mapping table". Hardware status: the new mapping is tested against mocks only and has not yet started a print on a real printer.

---

## Connector Families

Each connector family covers all printer models that share the same protocol:

| Connector | Protocol | Printer models |
|---|---|---|
| **Prusa Link** | PrusaLink REST API (HTTP polling) | MK4, XL, and any future Prusa models |
| **Elegoo SDCP** | SDCP WebSocket V3.0.0 (port 3030) | Centauri Carbon, Centauri Carbon 2 |
| **Klipper (Moonraker)** | Moonraker REST API (HTTP polling, port 7125) | Voron and any Klipper-firmware printer |
| **OctoPrint** | OctoPrint REST API (HTTP polling, operator-supplied port) | Any printer running OctoPrint/OctoPi |

The `printer.type` DB column stores the connector identifier (`prusa`, `elegoo-centauri`, `bambu`, `klipper`, or `octoprint`). The model column (`centauri-carbon`, etc.) is used only for display grouping in the UI.

---

## Driver Architecture

A new `server/drivers/` directory. Each driver exports four functions with the same interface:

```
getStatus(printer)
  → { status, progress, timeRemaining, currentFile }

uploadAndPrint(printer, filePath, filename)
  → resolves when print confirmed started

cancelJob(printer)
  → resolves when cancellation confirmed

checkIfPrinting(printer)
  → boolean
```

`currentFile` is the display name of the file currently printing, or `null`. Elegoo SDCP reads this directly from `PrintInfo.Filename` (timestamp prefix stripped). Prusa Link returns `null` — the poller falls back to a jobs → gcodes DB join.

The driver registry (`server/drivers/index.js`) maps `printer.type → driver module`. The poller and scheduler call `getDriver(printer.type)` and never touch brand-specific code directly.

---

## Files to Create

| File | Purpose | Status |
|---|---|---|
| `server/drivers/index.js` | Driver registry — maps type string to module | **Done** |
| `server/drivers/prusa.js` | Extracts existing PrusaLink logic from poller.js / scheduler.js | **Done** |
| `server/drivers/elegoo-centauri.js` | New SDCP WebSocket implementation | **Done** |
| `server/drivers/klipper.js` | Moonraker REST API implementation | **Done** |

---

## Files to Modify

| File | What changes | Status |
|---|---|---|
| `server/poller.js` | Replace direct axios PrusaLink calls with `driver.getStatus(printer)` | **Done** |
| `server/scheduler.js` | Replace `_uploadGCode()` with `driver.uploadAndPrint(...)` | **Done** |
| `server/routes/printers.js` | Add `elegoo-centauri` type, `centauri-carbon` model, make `api_key` optional | **Done** |
| `client/src/pages/Fleet.jsx` | Add `centauri-carbon` to model list and labels | **Done** |
| `client/src/pages/Dashboard.jsx` | Same model list additions | **Done** |
| `client/src/pages/Settings.jsx` | Add model option; hide API key field for Elegoo brand | **Done** |

No DB schema changes are needed. The existing columns (`type`, `api_key`, `model`, `job_name`, `job_progress`, `job_time_remaining`) are all reusable.

---

## New Dependency

```bash
npm install sdcp
```

Uses the `sdcp` npm package (blakejrobinson) which wraps the SDCP WebSocket protocol, handling connection management, message framing, UUID-matched request/response correlation, and auto-reconnect. This replaced the original plan to use `ws` directly.

---

## Elegoo SDCP Notes

- Persistent WebSocket connection per printer (port 3030), managed inside the driver
- Reconnect on drop — the driver holds connections in a module-level Map keyed by printer ID
- Message format: `{ Id: "<uuid>", Data: { Cmd: <int>, RequestID: "<uuid>", MainboardID: "<str>" }, Topic: "..." }`
- No authentication — LAN access only; `api_key` stored as `''` in DB

### External References

- [OpenCentauri API docs](https://docs.opencentauri.cc/software/api/) — community-maintained spec
- [cassini](https://github.com/vvuk/cassini) — Node.js SDCP client (reference implementation)
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — Home Assistant integration with comprehensive state mapping
- [RemmyLee/carbon](https://github.com/RemmyLee/carbon) — developer documentation for SDCP

---

## OctoPrint Notes

OctoPrint is a plain HTTP REST API (no persistent connection, `X-Api-Key` auth), so `server/drivers/octoprint.js` follows the Prusa/Klipper stateless-polling pattern rather than the Elegoo/Bambu persistent-connection pattern.

- `GET /api/printer` → `state.flags` (`operational`, `printing`, `paused`, `pausing`, `cancelling`, `error`, `closedOrError`) is the canonical status source.
- `GET /api/job` → `progress.completion` (0–100), `progress.printTimeLeft` (seconds), `job.file.name` supply progress and the current filename.
- Upload: `POST /api/files/local` (multipart) with `select=true` and `print=true` form fields — uploads and starts the print in one call, unlike PrusaLink (separate header) or Moonraker (separate `print` field only).
- Cancel: `POST /api/job` with `{"command": "cancel"}` — actually implemented (unlike Prusa's stub, since OctoPrint exposes a reliable cancel endpoint).
- No dedicated port field: OctoPrint commonly runs on `:5000` rather than `:80`, so the operator includes the port directly in the `ip` field (e.g. `192.168.1.50:5000`), same as how Prusa's `ip` field already accepts a host:port pair.

### FINISHED detection

Unlike PrusaLink (`FINISHED` state) or Moonraker (`complete` state), OctoPrint has no persistent "just completed" flag — after a print finishes it reports the same `operational` flags as a printer that never printed. The driver detects completion by combining flags with the job endpoint: not printing/paused, a job file is still loaded, and `progress.completion === 100`. This condition clears itself once the next print starts (completion resets), and `poller.js` only reacts to it once since it only fires `statusChange` on a DB status transition — so no additional per-printer state needs to live in the driver.

## G-Code Filename Parsing

The existing Prusa Slicer filename regex (`^(\d+)x ... .bgcode$`) will not match Elegoo/OrcaSlicer output. This is fine — the system already handles parse failures gracefully: it returns `parse_failed: true` and the operator enters `parts_per_plate` and model manually. No code change is needed for G-code parsing in Phase 6.

---

## What Is Not Changing

- The entire state machine in `poller.js` (hold logic, cold-start handling, event emission)
- The dispatch batching, ceiling math, retry logic, and part-cascade fallthrough in `scheduler.js`
- The DB schema
- All existing Prusa functionality

The driver layer is an extraction + addition — not a rewrite.
