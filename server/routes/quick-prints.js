const express = require('express');
const quickPrints = require('../quick-prints');

// Quick prints: one-off jobs without a project (see server/quick-prints.js).
//
// Adding one is two calls from the Quick Print page: POST /api/quick-prints/parts creates
// the part here, then the file goes through the normal POST /api/gcodes/upload (sliced-file
// validation, estimates, filament source), which also triggers the dispatch sweep. If the
// upload fails the page deletes the part again with DELETE /api/parts/:id.
module.exports = (db) => {
  const router = express.Router();

  // GET /api/quick-prints: the quick-print project and its most recent parts, newest first,
  // each with its G-code and any job currently uploading or printing.
  router.get('/', (req, res) => {
    const projectId = quickPrints.quickProjectId(db);
    if (projectId == null) return res.json({ project: null, parts: [] });

    const project = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(projectId);
    const parts = db.prepare(`
      SELECT id, name, target_qty, completed_qty, status, created_at
      FROM parts WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100
    `).all(projectId);

    const gcodeStmt = db.prepare(`
      SELECT id, filename, printer_model, parts_per_plate, est_print_secs
      FROM gcodes WHERE part_id = ? ORDER BY id LIMIT 1
    `);
    const jobsStmt = db.prepare(`
      SELECT jobs.id, jobs.status, jobs.parts_per_plate, jobs.started_at, printers.id AS printer_id, printers.name AS printer_name
      FROM jobs LEFT JOIN printers ON printers.id = jobs.printer_id
      WHERE jobs.part_id = ? AND jobs.status IN ('uploading', 'printing')
      ORDER BY jobs.id
    `);
    for (const part of parts) {
      part.gcode = gcodeStmt.get(part.id) || null;
      part.active_jobs = jobsStmt.all(part.id);
    }
    res.json({ project, parts });
  });

  // POST /api/quick-prints/parts: create a quick print's part.
  // Body: { name, copies, parts_per_plate? } where copies is how many plates to print and
  // parts_per_plate how many parts one plate makes (default 1). The part's target is
  // copies * parts_per_plate. Returns 201 with the part and the project id.
  router.post('/parts', (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
    const copies = Number(req.body.copies);
    const perPlate = req.body.parts_per_plate === undefined || req.body.parts_per_plate === '' ? 1 : Number(req.body.parts_per_plate);
    const missing = [];
    if (!name) missing.push('name');
    if (!Number.isInteger(copies) || copies < 1 || copies > 1000) missing.push('copies (a whole number from 1 to 1000)');
    if (!Number.isInteger(perPlate) || perPlate < 1 || perPlate > 1000) missing.push('parts_per_plate (a whole number from 1 to 1000)');
    if (missing.length) return res.status(400).json({ error: `Invalid or missing: ${missing.join(', ')}` });

    const now = Date.now();
    const result = db.transaction(() => {
      const project = quickPrints.ensureQuickProject(db, now);
      // Every quick print finishing completes the project, like any project. A new one
      // reopens it so its part can dispatch. A project an operator paused stays paused.
      if (project.status === 'completed') {
        db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now, project.id);
      }
      const maxRow = db.prepare('SELECT MAX(sort_order) AS max FROM parts WHERE project_id = ?').get(project.id);
      const inserted = db.prepare(`
        INSERT INTO parts (project_id, name, target_qty, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(project.id, name, copies * perPlate, (maxRow?.max ?? -1) + 1, now, now);
      return { projectId: project.id, partId: inserted.lastInsertRowid };
    })();

    res.status(201).json({
      project_id: result.projectId,
      part: db.prepare('SELECT * FROM parts WHERE id = ?').get(result.partId),
    });
  });

  return router;
};
