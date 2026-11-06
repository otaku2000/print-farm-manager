import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

const inputStyle = {
  background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0',
  padding: '5px 8px', fontSize: 13, width: 90,
};
const btn = (bg, color) => ({
  background: bg, color, border: 'none', borderRadius: 4, padding: '5px 12px',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
});

function fmtDate(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function reasonText(p) {
  if (p.overdue_reason === 'both') return 'Overdue: days and print hours';
  if (p.overdue_reason === 'days') return 'Overdue: days';
  if (p.overdue_reason === 'hours') return 'Overdue: print hours';
  return 'OK';
}

function PrinterRow({ p, onChanged, showToast, confirm }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [days, setDays] = useState(p.custom_days ?? '');
  const [hours, setHours] = useState(p.custom_hours ?? '');
  const [history, setHistory] = useState([]);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/maintenance/${p.printer_id}/history`).catch(() => null);
    if (res && res.ok) setHistory(await res.json());
  }, [p.printer_id]);

  useEffect(() => { if (open) loadHistory(); }, [open, loadHistory]);

  const markDone = async () => {
    const res = await fetch(`/api/maintenance/${p.printer_id}/done`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Could not log maintenance: ' + (body.error || res.status), 'error');
    }
    setNote('');
    showToast(`${p.name} marked as serviced`);
    loadHistory();
    onChanged();
  };

  const saveOverrides = async () => {
    const res = await fetch(`/api/maintenance/${p.printer_id}/intervals`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interval_days: days === '' ? null : Number(days),
        interval_hours: hours === '' ? null : Number(hours),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Could not save intervals: ' + (body.error || res.status), 'error');
    }
    showToast('Intervals saved');
    onChanged();
  };

  const deleteEntry = async (id) => {
    const ok = await confirm({
      title: 'Delete log entry?',
      message: 'This removes the entry and restarts the interval from the previous service.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/maintenance/entry/${id}`, { method: 'DELETE' });
    if (!res.ok) return showToast('Delete failed: ' + res.status, 'error');
    loadHistory();
    onChanged();
  };

  return (
    <div style={{ background: '#131720', border: `1px solid ${p.overdue ? '#92400e' : '#1e2433'}`, borderRadius: 8, marginBottom: 8 }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, minWidth: 140 }}>{p.name}</span>
        <span style={{ color: '#64748b', fontSize: 12, fontFamily: 'monospace' }}>{p.model}</span>
        <span style={{ color: '#94a3b8', fontSize: 13, flex: 1, minWidth: 200 }}>
          {Math.floor(p.days_since)} / {p.interval_days} days &middot; {Math.floor(p.print_hours_since)} / {p.interval_hours} print hrs
          &middot; last service: {fmtDate(p.last_performed_at)}
        </span>
        <span style={{
          background: p.overdue ? '#78350f' : '#14532d', color: p.overdue ? '#fbbf24' : '#86efac',
          borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700,
        }}>
          {reasonText(p)}
        </span>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid #1e2433', padding: 14, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 260 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6 }}>Log a service (restarts both counters)</div>
            <input
              style={{ ...inputStyle, width: 240, marginBottom: 8, display: 'block' }}
              placeholder="Note (optional)" maxLength={500} value={note}
              onChange={e => setNote(e.target.value)}
            />
            <button style={btn('#2563eb', '#fff')} onClick={markDone}>Mark serviced now</button>
          </div>

          <div style={{ minWidth: 260 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6 }}>Override intervals for this printer (blank = farm default)</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input style={inputStyle} type="number" min="1" placeholder="days" value={days} onChange={e => setDays(e.target.value)} />
              <span style={{ color: '#64748b', fontSize: 12 }}>days</span>
              <input style={inputStyle} type="number" min="1" placeholder="hours" value={hours} onChange={e => setHours(e.target.value)} />
              <span style={{ color: '#64748b', fontSize: 12 }}>print hrs</span>
            </div>
            <button style={btn('#1e293b', '#e2e8f0')} onClick={saveOverrides}>Save intervals</button>
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6 }}>History</div>
            {history.length === 0 && <div style={{ color: '#475569', fontSize: 13 }}>No services logged yet.</div>}
            {history.map(h => (
              <div key={h.id} style={{ display: 'flex', gap: 10, fontSize: 13, color: '#cbd5e1', marginBottom: 4, alignItems: 'center' }}>
                <span>{fmtDate(h.performed_at)}</span>
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
  const [defDays, setDefDays] = useState('');
  const [defHours, setDefHours] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/maintenance');
      if (!res.ok) throw new Error('Failed to load maintenance data');
      const d = await res.json();
      setData(d);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Seed the default inputs once, the first time data arrives (not on every refetch, which
  // would overwrite what the operator is typing).
  useEffect(() => {
    if (data && defDays === '' && defHours === '') {
      setDefDays(String(data.defaults.interval_days));
      setDefHours(String(data.defaults.interval_hours));
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveDefaults = async () => {
    for (const [key, val] of [['maintenance_interval_days', defDays], ['maintenance_interval_hours', defHours]]) {
      const res = await fetch(`/api/settings/${key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: val }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return showToast('Save failed: ' + (body.error || res.status), 'error');
      }
    }
    showToast('Default intervals saved');
    load();
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Maintenance</h1>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        A printer is flagged when it reaches either limit since its last logged service (or since it was added).
        Warnings only: nothing here stops a printer from receiving jobs.
      </p>

      <div style={{ background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>Farm default:</span>
        <span style={{ color: '#94a3b8', fontSize: 13 }}>every</span>
        <input style={inputStyle} type="number" min="1" value={defDays} onChange={e => setDefDays(e.target.value)} />
        <span style={{ color: '#94a3b8', fontSize: 13 }}>days or</span>
        <input style={inputStyle} type="number" min="1" value={defHours} onChange={e => setDefHours(e.target.value)} />
        <span style={{ color: '#94a3b8', fontSize: 13 }}>print hours, whichever comes first</span>
        <button style={btn('#2563eb', '#fff')} onClick={saveDefaults}>Save</button>
      </div>

      {error && <div style={{ color: '#f87171', marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: '#64748b' }}>Loading...</div>}

      {data && data.overdue_count > 0 && (
        <div style={{ background: '#78350f', border: '1px solid #92400e', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#fbbf24', fontWeight: 600, fontSize: 14 }}>
          {data.overdue_count} printer{data.overdue_count !== 1 ? 's' : ''} due for maintenance
        </div>
      )}

      {data && data.printers.map(p => (
        <PrinterRow key={p.printer_id} p={p} onChanged={load} showToast={showToast} confirm={confirm} />
      ))}
      {data && data.printers.length === 0 && <div style={{ color: '#64748b' }}>No active printers.</div>}

      {toastEl}
      {confirmModal}
    </div>
  );
}
