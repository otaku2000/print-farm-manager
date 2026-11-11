import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

// Maintenance: separate jobs (clean the build plate, lube the rods, replace filters, ...),
// each with its own interval, tracked per printer. See server/maintenance-tasks.js.

const inputStyle = {
  background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0',
  padding: '5px 8px', fontSize: 13, boxSizing: 'border-box',
};
const btn = (bg, color) => ({
  background: bg, color, border: 'none', borderRadius: 4, padding: '5px 12px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
const cardStyle = { background: '#131720', border: '1px solid #1e2433', borderRadius: 8 };

function fmtDate(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Today as YYYY-MM-DD in the browser's local time zone (the format <input type="date"> uses).
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The time to log for a picked date: now for today, so the counters restart from this
// moment, and local midnight for an earlier day. Midnight means print hours from later that
// day count toward the next interval, which errs toward doing the job early.
function performedAtFor(isoDate) {
  if (isoDate === todayIso()) return Date.now();
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

const DAY_MS = 86400000;

// Whole calendar days from today to the due date, in the browser's time zone.
function daysUntil(ms) {
  const due = new Date(ms); due.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((due - today) / DAY_MS);
}

function dueIn(ms) {
  const d = daysUntil(ms);
  if (d === 0) return 'due today';
  if (d === 1) return 'in 1 day';
  if (d > 1) return `in ${d} days`;
  return d === -1 ? '1 day overdue' : `${-d} days overdue`;
}

function intervalText(t) {
  const parts = [];
  if (t.interval_days != null) parts.push(`${t.interval_days} days`);
  if (t.interval_hours != null) parts.push(`${t.interval_hours} print hrs`);
  return parts.length ? `every ${parts.join(' or ')}` : 'no interval';
}

function statusChip(s) {
  if (s.overdue) {
    const why = s.overdue_reason === 'hours' ? 'print hours' : s.overdue_reason === 'both' ? 'days and hours' : 'days';
    return { text: `Overdue (${why})`, bg: '#78350f', color: '#fbbf24' };
  }
  if (s.due_soon) return { text: 'Due soon', bg: '#422006', color: '#fcd34d' };
  return { text: 'OK', bg: '#14532d', color: '#86efac' };
}

function Chip({ chip }) {
  return (
    <span style={{ background: chip.bg, color: chip.color, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {chip.text}
    </span>
  );
}

// ── Task list editor ─────────────────────────────────────────────────────────

function TaskRow({ task, onChanged, showToast, confirm }) {
  const [name, setName] = useState(task.name);
  const [days, setDays] = useState(task.interval_days ?? '');
  const [hours, setHours] = useState(task.interval_hours ?? '');
  const dirty = name !== task.name || String(days) !== String(task.interval_days ?? '') || String(hours) !== String(task.interval_hours ?? '');

  async function save(extra = {}) {
    const res = await fetch(`/api/maintenance/tasks/${task.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, interval_days: days === '' ? null : Number(days), interval_hours: hours === '' ? null : Number(hours), ...extra }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Could not save task: ' + (body.error || res.status), 'error');
    }
    showToast(extra.is_active === 0 ? `"${task.name}" disabled` : extra.is_active === 1 ? `"${task.name}" enabled` : 'Task saved');
    onChanged();
  }

  async function remove() {
    const ok = await confirm({
      title: 'Delete this task?',
      message: `"${task.name}" will be removed from every printer. A task that has been logged can only be disabled.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/maintenance/tasks/${task.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Delete failed: ' + (body.error || res.status), 'error');
    }
    showToast(`"${task.name}" deleted`);
    onChanged();
  }

  const inactive = !task.is_active;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderBottom: '1px solid #1e2433', opacity: inactive ? 0.55 : 1 }}>
      <input value={name} maxLength={120} onChange={e => setName(e.target.value)} title={task.description || ''}
        style={{ ...inputStyle, flex: '1 1 240px', minWidth: 180 }} />
      <span style={{ color: '#64748b', fontSize: 12 }}>every</span>
      <input type="number" min="1" placeholder="none" value={days} onChange={e => setDays(e.target.value)} style={{ ...inputStyle, width: 70 }} />
      <span style={{ color: '#64748b', fontSize: 12 }}>days or</span>
      <input type="number" min="1" placeholder="none" value={hours} onChange={e => setHours(e.target.value)} style={{ ...inputStyle, width: 80 }} />
      <span style={{ color: '#64748b', fontSize: 12 }}>print hrs</span>
      <button style={{ ...btn(dirty ? '#2563eb' : '#1e293b', dirty ? '#fff' : '#64748b') }} disabled={!dirty} onClick={() => save()}>Save</button>
      <button style={btn('transparent', '#94a3b8')} onClick={() => save({ is_active: inactive ? 1 : 0 })}>{inactive ? 'Enable' : 'Disable'}</button>
      <button style={btn('transparent', '#f87171')} onClick={remove}>Delete</button>
    </div>
  );
}

function TaskSettings({ onChanged, showToast, confirm }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [hours, setHours] = useState('');

  const load = useCallback(() => {
    fetch('/api/maintenance/tasks').then(r => r.json()).then(setTasks).catch(() => {});
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const changed = () => { load(); onChanged(); };

  async function add(e) {
    e.preventDefault();
    const res = await fetch('/api/maintenance/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, interval_days: days === '' ? null : Number(days), interval_hours: hours === '' ? null : Number(hours) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Could not add task: ' + (body.error || res.status), 'error');
    }
    setName(''); setDays(''); setHours('');
    showToast('Task added');
    changed();
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: '#64748b', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s', display: 'inline-block' }}>▶</span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Maintenance tasks</span>
        <span style={{ color: '#64748b', fontSize: 12 }}>Edit the jobs and how often each is due. Applies to every printer.</span>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #1e2433', padding: '6px 14px 14px' }}>
          {tasks.map(t => <TaskRow key={`${t.id}-${t.name}-${t.interval_days}-${t.interval_hours}-${t.is_active}`} task={t} onChanged={changed} showToast={showToast} confirm={confirm} />)}
          <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <input value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="New task, e.g. Lubricate the Z rails"
              style={{ ...inputStyle, flex: '1 1 240px', minWidth: 180 }} />
            <span style={{ color: '#64748b', fontSize: 12 }}>every</span>
            <input type="number" min="1" placeholder="days" value={days} onChange={e => setDays(e.target.value)} style={{ ...inputStyle, width: 70 }} />
            <span style={{ color: '#64748b', fontSize: 12 }}>days or</span>
            <input type="number" min="1" placeholder="hours" value={hours} onChange={e => setHours(e.target.value)} style={{ ...inputStyle, width: 80 }} />
            <span style={{ color: '#64748b', fontSize: 12 }}>print hrs</span>
            <button type="submit" style={btn('#2563eb', '#fff')} disabled={!name.trim()}>Add task</button>
          </form>
          <div style={{ color: '#475569', fontSize: 12, marginTop: 8 }}>
            Leave days or hours empty for no limit of that kind. Default intervals are general FDM guidance; adjust them for your printers and materials.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Per printer ──────────────────────────────────────────────────────────────

function PrinterRow({ p, tasks, onChanged, showToast, confirm }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [serviceDate, setServiceDate] = useState(todayIso);
  const [selected, setSelected] = useState(new Set());
  const [history, setHistory] = useState([]);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/maintenance/${p.printer_id}/history`).catch(() => null);
    if (res && res.ok) setHistory(await res.json());
  }, [p.printer_id]);
  useEffect(() => { if (open) loadHistory(); }, [open, loadHistory]);

  const taskName = id => tasks.find(t => t.id === id)?.name || 'Task';
  const toggle = id => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function log(taskIds) {
    if (!serviceDate) return showToast('Pick the date the work was done', 'error');
    if (serviceDate > todayIso()) return showToast('The date cannot be in the future', 'error');
    const performedAt = performedAtFor(serviceDate);
    const res = await fetch(`/api/maintenance/${p.printer_id}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, performed_at: performedAt, task_ids: taskIds }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Could not log maintenance: ' + (body.error || res.status), 'error');
    }
    setNote(''); setSelected(new Set()); setServiceDate(todayIso());
    showToast(taskIds.length
      ? `${p.name}: ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} logged for ${fmtDate(performedAt)}`
      : `${p.name}: full service logged for ${fmtDate(performedAt)}`);
    loadHistory();
    onChanged();
  }

  async function deleteEntry(id) {
    const ok = await confirm({
      title: 'Delete log entry?',
      message: 'This removes the entry. The task clock goes back to its previous entry.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/maintenance/entry/${id}`, { method: 'DELETE' });
    if (!res.ok) return showToast('Delete failed: ' + res.status, 'error');
    loadHistory();
    onChanged();
  }

  const summary = p.overdue_count > 0
    ? { text: `${p.overdue_count} overdue`, bg: '#78350f', color: '#fbbf24' }
    : p.due_soon_count > 0 ? { text: `${p.due_soon_count} due soon`, bg: '#422006', color: '#fcd34d' }
      : { text: 'All up to date', bg: '#14532d', color: '#86efac' };
  const nextTask = p.tasks.filter(t => t.next_due_at != null).sort((a, b) => a.next_due_at - b.next_due_at)[0];

  return (
    <div style={{ ...cardStyle, border: `1px solid ${p.overdue ? '#92400e' : '#1e2433'}`, marginBottom: 8 }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 14, minWidth: 120 }}>{p.name}</span>
        <span style={{ color: '#64748b', fontSize: 12, fontFamily: 'monospace' }}>{p.model}</span>
        <span style={{ color: '#94a3b8', fontSize: 13, flex: 1, minWidth: 200 }}>
          {nextTask ? <>next: {taskName(nextTask.task_id)} ({fmtDate(nextTask.next_due_at)}, {dueIn(nextTask.next_due_at)})</> : 'no dated tasks'}
        </span>
        <Chip chip={summary} />
      </div>

      {open && (
        <div style={{ borderTop: '1px solid #1e2433', padding: 14 }}>
          <style>{`
            .mt-table { display: grid; grid-template-columns: 24px minmax(160px, 2fr) minmax(90px, 1fr) minmax(140px, 1.4fr) minmax(120px, 1.2fr) auto; column-gap: 12px; row-gap: 6px; align-items: center; font-size: 13px; }
            @media (max-width: 700px) { .mt-table { grid-template-columns: 24px 1fr auto; } .mt-hide { display: none; } }
          `}</style>
          <div className="mt-table">
            <span />
            <span style={{ color: '#475569', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Task</span>
            <span className="mt-hide" style={{ color: '#475569', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Last done</span>
            <span className="mt-hide" style={{ color: '#475569', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Next due</span>
            <span className="mt-hide" style={{ color: '#475569', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Used</span>
            <span />
            {p.tasks.map(s => {
              const t = tasks.find(x => x.id === s.task_id);
              const chip = statusChip(s);
              return (
                <div key={s.task_id} style={{ display: 'contents' }}>
                  <input type="checkbox" checked={selected.has(s.task_id)} onChange={() => toggle(s.task_id)} style={{ accentColor: '#3b82f6' }} />
                  <span title={t?.description || ''} style={{ color: '#e2e8f0' }}>
                    {t?.name}
                    <span style={{ display: 'block', color: '#475569', fontSize: 11 }}>{t ? intervalText(t) : ''}</span>
                  </span>
                  <span className="mt-hide" style={{ color: '#94a3b8' }}>{fmtDate(s.last_performed_at)}</span>
                  <span className="mt-hide" style={{ color: s.overdue ? '#f87171' : s.due_soon ? '#fbbf24' : '#94a3b8' }}>
                    {s.next_due_at != null ? `${fmtDate(s.next_due_at)} (${dueIn(s.next_due_at)})` : 'by print hours'}
                  </span>
                  <span className="mt-hide" style={{ color: '#64748b' }}>
                    {[s.interval_days != null ? `${Math.floor(s.days_since)}/${s.interval_days} d` : null,
                      s.interval_hours != null ? `${Math.floor(s.print_hours_since)}/${s.interval_hours} h` : null].filter(Boolean).join(' · ')}
                  </span>
                  <Chip chip={chip} />
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: '1px solid #1e2433' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 12 }}>
              Done on
              <input type="date" value={serviceDate} max={todayIso()} onChange={e => setServiceDate(e.target.value)}
                style={{ ...inputStyle, width: 150, colorScheme: 'dark' }} />
            </label>
            <input placeholder="Note (optional)" maxLength={500} value={note} onChange={e => setNote(e.target.value)}
              style={{ ...inputStyle, flex: '1 1 200px' }} />
            <button style={{ ...btn(selected.size ? '#2563eb' : '#1e293b', selected.size ? '#fff' : '#64748b') }}
              disabled={!selected.size} onClick={() => log([...selected])}>
              Log {selected.size || ''} selected task{selected.size === 1 ? '' : 's'}
            </button>
            <button style={btn('#1e293b', '#e2e8f0')} onClick={() => log([])}>Log full service (all tasks)</button>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6 }}>History</div>
            {history.length === 0 && <div style={{ color: '#475569', fontSize: 13 }}>Nothing logged yet.</div>}
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', gap: 10, fontSize: 13, color: '#cbd5e1', marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ minWidth: 100 }}>{fmtDate(h.performed_at)}</span>
                <span style={{ minWidth: 200 }}>{h.task_id == null ? 'Full service' : (h.task_name || 'Deleted task')}</span>
                <span style={{ color: '#64748b', flex: 1 }}>{h.note || ''}</span>
                <button style={btn('transparent', '#f87171')} onClick={() => deleteEntry(h.id)}>Delete</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Maintenance() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/maintenance');
      if (!res.ok) throw new Error('Failed to load maintenance data');
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Maintenance</h1>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        Each job has its own interval in days and/or print hours, counted from when it was last done on that printer
        (a full service counts for every job). Warnings only: nothing here stops a printer from receiving jobs.
      </p>

      <TaskSettings onChanged={load} showToast={showToast} confirm={confirm} />

      {error && <div style={{ color: '#f87171', marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: '#64748b' }}>Loading...</div>}

      {data && data.overdue_count > 0 && (
        <div style={{ background: '#78350f', border: '1px solid #92400e', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#fbbf24', fontWeight: 600, fontSize: 14 }}>
          {data.overdue_count} printer{data.overdue_count !== 1 ? 's have' : ' has'} overdue maintenance
        </div>
      )}

      {data && data.printers.map(p => (
        <PrinterRow key={p.printer_id} p={p} tasks={data.tasks} onChanged={load} showToast={showToast} confirm={confirm} />
      ))}
      {data && data.printers.length === 0 && <div style={{ color: '#64748b' }}>No active printers.</div>}

      {toastEl}
      {confirmModal}
    </div>
  );
}
