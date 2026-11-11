// One-off prints without setting up a project. Each quick print is an ordinary part in one
// built-in project, "Quick prints", so it goes through the same pipeline as project work:
// candidate query, filament and nozzle checks, AMS slot choice, holds and Set Ready sign-off,
// part counts, job history, and the forward schedule. Nothing here dispatches by itself.
//
// Priority: projects dispatch in priority order, lowest number first, and reordering numbers
// them from 0. The quick-print project is created at QUICK_PRINT_PRIORITY (-1), so every
// ordering already in the codebase (the candidate query, the queue, the schedule, the
// dashboard, the projects list) puts it ahead of project work, and PUT /api/projects/reorder
// leaves it there. Within it, quick prints go in the order they were added.
//
// The project's id is kept in the settings table, so this needs no schema change and moves
// with a backup. If the project is deleted, the next quick print creates a new one.

const SETTING_KEY = 'quick_print_project_id';
const QUICK_PRINT_PRIORITY = -1;
const PROJECT_NAME = 'Quick prints';
const PROJECT_DESCRIPTION = 'One-off prints added from the Quick Print page. Built in: kept ahead of all project work.';

// The quick-print project's id, or null when none exists yet. Never creates one.
function quickProjectId(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
  const id = row ? parseInt(row.value, 10) : NaN;
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT id FROM projects WHERE id = ?').get(id) ? id : null;
}

// Returns the quick-print project row, creating it (active, top priority) when missing.
function ensureQuickProject(db, now = Date.now()) {
  const existing = quickProjectId(db);
  if (existing != null) return db.prepare('SELECT * FROM projects WHERE id = ?').get(existing);
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO projects (name, description, status, priority, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `).run(PROJECT_NAME, PROJECT_DESCRIPTION, QUICK_PRINT_PRIORITY, now, now);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTING_KEY, String(result.lastInsertRowid));
    console.log(`[quick-prints] Created the "${PROJECT_NAME}" project (id ${result.lastInsertRowid})`);
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  })();
}

function isQuickProject(db, projectId) {
  const id = quickProjectId(db);
  return id != null && Number(projectId) === id;
}

module.exports = { quickProjectId, ensureQuickProject, isQuickProject, QUICK_PRINT_PRIORITY, SETTING_KEY };
