// The dispatch candidate predicate, in exactly one place.
//
// Two callers need to answer "what would this printer print next?": the scheduler, which
// actually dispatches (server/scheduler.js, _reserveJob), and the forward-looking schedule,
// which projects the queue without touching anything (server/projection.js). Two copies of
// this WHERE clause would drift the first time a targeting rule changed, and a schedule
// that quietly disagrees with dispatch is worse than no schedule: the operator plans a
// shift around a projection the farm will not follow.
//
// What is shared is the predicate and the ordering, because those are the eligibility
// contract: open part, active project, matching printer model, group/material/color
// targeting where a per-gcode value overrides the project default, ordered by project
// priority, then project age, then part sort_order, then part age.
//
// What is NOT shared is the SELECT list. Each caller names the columns it needs (the
// projection wants the time estimates and display names the scheduler has no use for).
// Keeping the lists separate means adding a column for one caller cannot widen the other's
// query, which is what keeps this refactor behaviour-neutral for dispatch.
//
// GET /api/parts/:id/dispatch-status in routes/parts.js mirrors these same rules in JS to
// explain them one part at a time, and GET /api/parts/queue reuses that mirror plus this
// ORDER BY to list the whole queue; if the rules here change, both change with them.

// Bind order for every query built here: printer model, printer group, the printer's
// filament set as JSON (filamentsParam in server/printer-filaments.js), then one parameter
// per excluded part id.
//
// The filament predicate passes when the part has no material or color requirement, or
// when ANY entry of the set meets both. A manual printer's set is its single
// loaded_material/loaded_color entry, which makes this the same equality check it always
// was; an Auto printer's set is one entry per loaded AMS spool.
function candidateSql(selectColumns, excludeCount = 0) {
  const excludeClause = excludeCount > 0
    ? `AND parts.id NOT IN (${Array.from({ length: excludeCount }, () => '?').join(',')})`
    : '';

  return `
        SELECT
${selectColumns}
        FROM parts
        JOIN gcodes   ON gcodes.part_id    = parts.id
        JOIN projects ON projects.id       = parts.project_id
        WHERE parts.status    = 'open'
          AND projects.status = 'active'
          AND gcodes.printer_model = ?
          AND (COALESCE(gcodes.allowed_groups, projects.allowed_groups) IS NULL OR EXISTS (
            SELECT 1 FROM json_each(COALESCE(gcodes.allowed_groups, projects.allowed_groups)) WHERE value = ?
          ))
          AND (
            (COALESCE(gcodes.required_material, projects.required_material) IS NULL
              AND COALESCE(gcodes.required_color, projects.required_color) IS NULL)
            OR EXISTS (
              SELECT 1 FROM json_each(?) AS loaded
              WHERE (COALESCE(gcodes.required_material, projects.required_material) IS NULL
                     OR json_extract(loaded.value, '$.material') = COALESCE(gcodes.required_material, projects.required_material))
                AND (COALESCE(gcodes.required_color, projects.required_color) IS NULL
                     OR json_extract(loaded.value, '$.color') = COALESCE(gcodes.required_color, projects.required_color))
            )
          )
          ${excludeClause}
        ORDER BY projects.priority ASC, projects.created_at ASC, parts.sort_order ASC, parts.created_at ASC
        LIMIT 1
      `;
}

// Exactly the columns _reserveJob reads: dispatch must not start seeing new columns as a
// side effect of the schedule needing them. The effective required material and color
// were added so an Auto printer can be sent to the AMS slot that matched.
const SCHEDULER_COLUMNS = `          parts.id          AS part_id,
          parts.target_qty,
          parts.completed_qty,
          parts.project_id,
          gcodes.id         AS gcode_id,
          gcodes.filename,
          gcodes.filepath,
          gcodes.parts_per_plate,
          gcodes.ams_slot,
          COALESCE(gcodes.required_material, projects.required_material) AS required_material,
          COALESCE(gcodes.required_color, projects.required_color)       AS required_color`;

// The projection additionally needs the two time estimates (to size a block), the
// display names (to label one), and the file path (for the nozzle-size skip that dispatch
// also applies, server/nozzle-compat.js).
const PROJECTION_COLUMNS = `          parts.id          AS part_id,
          parts.name        AS part_name,
          parts.target_qty,
          parts.completed_qty,
          parts.print_time_seconds,
          parts.project_id,
          projects.name     AS project_name,
          gcodes.id         AS gcode_id,
          gcodes.filename,
          gcodes.filepath,
          gcodes.parts_per_plate,
          gcodes.est_print_secs`;

module.exports = { candidateSql, SCHEDULER_COLUMNS, PROJECTION_COLUMNS };
