# Filament Library

Administrator-managed canonical lists of filament types and filament colors. These lists are the single source of truth for what materials and colors exist in the farm — printers and G-codes select from them rather than entering free text.

## Tables

### `filament_types`

| Column | Type    | Notes |
|--------|---------|-------|
| `id`   | INTEGER | PK, autoincrement |
| `name` | TEXT    | Unique, e.g. "PLA", "PETG", "ASA" |

### `filament_colors`

| Column      | Type    | Notes |
|-------------|---------|-------|
| `id`        | INTEGER | PK, autoincrement |
| `type_id`   | INTEGER | FK → `filament_types.id` (NOT NULL). A color belongs to exactly one type. |
| `name`      | TEXT    | Unique per type, e.g. "Black", "Galaxy Red". `UNIQUE(type_id, name)`. |
| `hex_color` | TEXT    | Optional hex code, e.g. "#FF0000". Shown as a color swatch in the Settings table. |

## API Endpoints — `server/routes/filaments.js`

All endpoints are mounted at `/api/filaments`.

### `GET /api/filaments/types`
Returns all filament types ordered by name.
```json
[{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }]
```

### `POST /api/filaments/types`
Add a new filament type.
- Body: `{ "name": "ASA" }`
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/types/:id`
Remove a filament type by ID.
- No foreign-key block — deleting a type does not clear printers or G-codes that reference it by name. The stored name string remains; the operator resolves via the printer/gcode form on next edit.
- Returns 404 if not found.

### `GET /api/filaments/colors`
Returns all filament colors ordered by name.
```json
[{ "id": 1, "name": "Black", "hex_color": "#000000" }, { "id": 2, "name": "Galaxy Red", "hex_color": null }]
```

### `POST /api/filaments/colors`
Add a new filament color.
- Body: `{ "type_id": 1, "name": "Galaxy Red", "hex_color": "#C0392B" }` — `hex_color` is optional; `type_id` is required.
- Returns: the created row with `type_name` included (201)
- Errors: 400 if name or type_id missing / type not found, 409 if name already exists for that type

### `DELETE /api/filaments/colors/:id`
Remove a filament color by ID. Same non-blocking behavior as type deletion.

## Where filament data is used

| Location | Field | Meaning |
|----------|-------|---------|
| `printers.loaded_material` | type name | What material is currently loaded on the printer |
| `printers.loaded_color` | color name | What color is currently loaded on the printer |
| `gcodes.required_material` | type name | Material required to print this G-code |
| `gcodes.required_color` | color name | Color required to print this G-code |

| `printers.filament_auto` | 0 or 1 | 1 = a Bambu printer matches against its AMS instead of the two fields above |

The scheduler uses `required_material` and `required_color` (a G-code's own, else its project's) to match G-codes to printers. A manual printer matches when its `loaded_material` / `loaded_color` equal them.

## Auto filament (Bambu with an AMS)

Setting a Bambu printer's Loaded Material to **Auto (from AMS)** (`filament_auto = 1`) makes it match against every spool its AMS reports, live, instead of one typed-in value. A part matches when any loaded spool has its material and color. Implemented in `server/printer-filaments.js`; the scheduler, the schedule projection, and the queue and dispatch-status diagnostics all build the printer's filament set there, and the shared candidate query (`server/candidate-query.js`) matches against it.

- **Material:** each spool is known by its product name (`tray_sub_brands`, such as "PETG HF") and its generic type (`tray_type`, "PETG"), so a requirement written either way matches. Names are compared to the library case-insensitively and use the library's spelling. A spool with no product name (a third-party spool) is known by its type only.
- **Color:** the AMS reports an exact hex, while requirements are library color names. Each spool gets the name of the nearest library color for that material, measured as RGB distance to the color's `hex_color`, up to 150 (out of 441). A library color with no `hex_color` can never be matched in Auto, so give every color you require a hex (for example Black `#000000`). A spool further than 150 from every library color has no color name and only matches parts with no color requirement. The limit stops a White spool being called "Black" just because Black is the only color with a hex.
- **Slot:** when an Auto printer matches a part through a spool, the print uses that spool's AMS slot instead of the slot saved on the G-code. A part with no filament requirement keeps the G-code's filament source: with "Match from AMS" (the upload form's default) the driver picks the tray by the sliced file's filament type and color, with a fixed slot it starts from that slot. The Bambu driver still checks the sliced file's filament type against the tray before uploading (docs/multi-brand.md, Bambu AMS mapping).
- **No report yet:** until the printer reports its AMS (after a restart or reconnect), an Auto printer has no filament and only matches parts with no requirement.
- **Spool swaps:** loading a spool is not a status change, so after every poll the scheduler re-checks idle, unheld Auto printers whose AMS contents changed and dispatches any that now match a waiting part.

Turning Auto on keeps the manual values stored, so switching back restores them. Auto is set when adding a printer in Settings, on the Printer Detail Edit form, or with Printers bulk edit (Bambu printers only).

## Settings UI

The **Filament Library** section in Settings has two sub-sections:

**Filament Types** — table of all types with delete buttons; add form with a required name field.

**Filament Colors** — table of all colors (with hex swatch if provided) and delete buttons; add form with a required name field and optional hex color picker.

## Client usage

All client pages that show material/color pickers (Settings add-printer form, Printers bulk edit, PrinterDetail edit form, Projects G-code upload and edit) fetch from `/api/filaments/types` and `/api/filaments/colors` and render `<select>` dropdowns rather than free-text `<input>` elements.
