import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import { readSlicedFilament, suggestFromLibrary, modelFromPrinter } from '../sliceFilament';

// Quick Print: send a one-off file to the farm without creating a project. Each quick print
// becomes a part in the built-in "Quick prints" project (server/quick-prints.js), which is
// kept ahead of all project work, so the next free matching printer takes it with the usual
// filament, nozzle, and sign-off rules.

const inputStyle = {
  background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0',
  padding: '6px 8px', fontSize: 13, boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 };
const btn = (bg, color) => ({
  background: bg, color, border: 'none', borderRadius: 5, padding: '7px 16px',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
});

// gcodes.ams_slot value for "pick the slot from the AMS at dispatch" (server/drivers/bambu-ams.js).
const AMS_MATCH = '-2';

// "1712345678901_H2S_Bracket.gcode.3mf" -> "H2S_Bracket"
function nameFromFile(filename) {
  return filename.replace(/\.(gcode\.3mf|3mf|bgcode|gcode)$/i, '').slice(0, 200);
}

function statusText(p, projectStatus) {
  const job = p.active_jobs[0];
  if (job) return job.status === 'uploading' ? `Sending to ${job.printer_name}` : `Printing on ${job.printer_name}`;
  if (p.status === 'closed') return 'Done';
  if (!p.gcode) return 'No file';
  if (projectStatus === 'paused' || projectStatus === 'draft') return 'Quick prints are paused';
  return `Waiting for a free ${p.gcode.printer_model.toUpperCase()} printer`;
}

function statusColor(text) {
  if (text.startsWith('Printing') || text.startsWith('Sending')) return '#60a5fa';
  if (text === 'Done') return '#86efac';
  if (text.startsWith('Waiting')) return '#fcd34d';
  return '#fca5a5';
}

export default function QuickPrint() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const [models, setModels] = useState([]);
  const [filamentTypes, setFilamentTypes] = useState([]);
  const [filamentColors, setFilamentColors] = useState([]);
  const [list, setList] = useState(null);

  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [copies, setCopies] = useState('1');
  const [perPlate, setPerPlate] = useState('1');
  const [amsSlot, setAmsSlot] = useState(AMS_MATCH);
  const [material, setMaterial] = useState('');
  const [color, setColor] = useState('');
  const [parsedEstSecs, setParsedEstSecs] = useState(null);
  const [parsedGrams, setParsedGrams] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState(null);
  const [fileFilamentNote, setFileFilamentNote] = useState(null);

  const loadList = useCallback(() => {
    return fetch('/api/quick-prints').then(r => r.json()).then(setList).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {});
    fetch('/api/filaments/types').then(r => r.json()).then(setFilamentTypes).catch(() => {});
    fetch('/api/filaments/colors').then(r => r.json()).then(setFilamentColors).catch(() => {});
    loadList();
    // Live list: background poll, errors swallowed.
    const timer = setInterval(loadList, 15000);
    return () => clearInterval(timer);
  }, [loadList]);

  const isBambu = !!models.find(m => m.model_id === model && m.connector === 'bambu');
  const bambuNeeds3mf = isBambu && file && !file.name.toLowerCase().endsWith('.3mf');

  async function onFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setError(null);
    setName(nameFromFile(f.name));
    setParsedEstSecs(null);
    setParsedGrams(null);
    try {
      const res = await fetch('/api/gcodes/parse-filename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f.name }),
      });
      const data = await res.json();
      if (!data.parse_failed) {
        if (data.parts_per_plate) setPerPlate(String(data.parts_per_plate));
        if (data.printer_model) setModel(data.printer_model);
        if (data.est_print_secs != null) setParsedEstSecs(data.est_print_secs);
      }
      if (data.material_grams != null) setParsedGrams(data.material_grams);
    } catch (_) {}

    // Suggest the printer model, Material and Color from the sliced file itself
    // (client/src/sliceFilament.js). The file's printer beats a guess from the filename.
    const fromFile = await readSlicedFilament(f);
    const fileModel = modelFromPrinter(fromFile?.printer, models);
    if (fileModel) setModel(fileModel);
    const suggested = suggestFromLibrary(fromFile, filamentTypes, filamentColors);
    setMaterial(suggested.material || '');
    setColor(suggested.color || '');
    setFileFilamentNote(suggested.material ? [suggested.material, suggested.color].filter(Boolean).join(' / ') : null);
  }

  function resetForm() {
    setFile(null); setName(''); setModel(''); setCopies('1'); setPerPlate('1');
    setAmsSlot(AMS_MATCH); setMaterial(''); setColor(''); setFileFilamentNote(null);
    setParsedEstSecs(null); setParsedGrams(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function submit(e) {
    e.preventDefault();
    if (!file) return setError('Choose a sliced file first.');
    if (!model) return setError('Select a printer model.');
    if (bambuNeeds3mf) return setError('Bambu printers need a sliced .3mf file.');
    if (!name.trim()) return setError('Give the print a name.');
    setError(null);
    setSubmitting(true);

    let partId = null;
    try {
      const res = await fetch('/api/quick-prints/parts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), copies: Number(copies), parts_per_plate: Number(perPlate) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not create the quick print (${res.status})`);
      partId = body.part.id;

      const fd = new FormData();
      fd.append('file', file);
      fd.append('part_id', String(partId));
      fd.append('parts_per_plate', String(perPlate));
      fd.append('printer_model', model);
      if (isBambu) fd.append('ams_slot', amsSlot);
      if (parsedEstSecs != null) fd.append('est_print_secs', String(parsedEstSecs));
      if (parsedGrams != null) fd.append('material_grams', String(parsedGrams));
      if (material) fd.append('required_material', material);
      if (color) fd.append('required_color', color);

      // XHR so a large file shows upload progress.
      const { ok, data } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/gcodes/upload');
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) setUploadPct(Math.round((ev.loaded / ev.total) * 100)); };
        xhr.onload = () => {
          let parsed = {};
          try { parsed = JSON.parse(xhr.responseText); } catch (_) {}
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: parsed });
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(fd);
      });
      if (!ok) throw new Error(data.error || 'Upload failed');

      showToast(`"${name.trim()}" queued: the next free ${model.toUpperCase()} printer will take it`);
      resetForm();
      loadList();
    } catch (err) {
      // Do not leave a part with no file behind.
      if (partId != null) await fetch(`/api/parts/${partId}`, { method: 'DELETE' }).catch(() => {});
      setError(err.message);
      showToast('Quick print failed: ' + err.message, 'error');
    } finally {
      setSubmitting(false);
      setUploadPct(null);
    }
  }

  async function removePart(p) {
    const ok = await confirm({
      title: 'Remove this quick print?',
      message: `"${p.name}" has not started yet. Removing it deletes it and its file.`,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/parts/${p.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return showToast('Remove failed: ' + (body.error || res.status), 'error');
    }
    showToast(`"${p.name}" removed`);
    loadList();
  }

  const colorsForMaterial = filamentColors.filter(c => c.type_name === material);
  const projectStatus = list?.project?.status;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Quick Print</h1>
      <p style={{ color: '#94a3b8', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        Send a one-off file without setting up a project. It goes ahead of project work to the next free
        printer of that model, with the usual filament and nozzle checks and Set Ready sign-off.
      </p>

      <form onSubmit={submit} className="qp-form" style={{ background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <style>{`
          .qp-form { max-width: 50%; }
          /* As many fields per row as fit. Each field spans 4 narrow tracks and Name spans 5,
             so Name is 25% wider than the other fields. Spacing is padding, not column gap,
             so the 4:5 ratio holds exactly. */
          .qp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); column-gap: 0; row-gap: 12px; }
          .qp-grid > div { grid-column: span 4; padding-right: 12px; }
          .qp-grid > .qp-full { grid-column: 1 / -1; }
          .qp-grid > .qp-name { grid-column: span 5; }
          @media (max-width: 900px) { .qp-form { max-width: 100%; } }
          @media (max-width: 600px) { .qp-grid > div, .qp-grid > .qp-name { grid-column: 1 / -1; } }
        `}</style>
        <div className="qp-grid">
          <div className="qp-full">
            <label style={labelStyle}>Sliced File *</label>
            <input ref={fileInputRef} type="file" accept=".3mf,.bgcode,.gcode" onChange={onFile}
              style={{ ...inputStyle, width: '100%' }} />
            {bambuNeeds3mf && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 4 }}>Bambu printers need a sliced .3mf file.</div>}
          </div>
          <div className="qp-name">
            <label style={labelStyle}>Name *</label>
            <input value={name} maxLength={200} onChange={e => setName(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="e.g. Replacement bracket" />
          </div>
          <div>
            <label style={labelStyle}>Printer Model *</label>
            <select value={model} onChange={e => setModel(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
              <option value="">Select…</option>
              {models.map(m => <option key={m.model_id} value={m.model_id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Copies (plates) *</label>
            <input type="number" min="1" max="1000" value={copies} onChange={e => setCopies(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          <div>
            <label style={labelStyle}>Parts per Plate</label>
            <input type="number" min="1" max="1000" value={perPlate} onChange={e => setPerPlate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
          </div>
          {isBambu && (
            <div>
              <label style={labelStyle}>Filament Source</label>
              <select value={amsSlot} onChange={e => setAmsSlot(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value={AMS_MATCH}>Match from AMS</option>
                <option value="-1">External Spool</option>
                {[0, 1, 2, 3].map(n => <option key={n} value={String(n)}>Fixed: AMS Slot {n + 1}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={labelStyle}>Material (optional)</label>
            <select value={material} onChange={e => { setMaterial(e.target.value); setColor(''); }} style={{ ...inputStyle, width: '100%' }}>
              <option value="">Any</option>
              {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Color (optional)</label>
            <select value={color} onChange={e => setColor(e.target.value)} disabled={!material} style={{ ...inputStyle, width: '100%', cursor: material ? 'pointer' : 'not-allowed' }}>
              <option value="">Any</option>
              {colorsForMaterial.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          {fileFilamentNote && (
            <div className="qp-full" style={{ fontSize: 12, color: '#64748b', marginTop: -4 }}>
              Material and color filled from the file ({fileFilamentNote}). Check they match the spool you will print with.
            </div>
          )}
        </div>
        {error && <div style={{ color: '#fca5a5', fontSize: 13, marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="submit" disabled={submitting || bambuNeeds3mf}
            style={{ ...btn('#2563eb', '#fff'), opacity: submitting || bambuNeeds3mf ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}>
            {submitting ? (uploadPct != null ? `Uploading… ${uploadPct}%` : 'Sending…') : 'Print'}
          </button>
          <span style={{ fontSize: 12, color: '#64748b' }}>
            {Number(copies) > 0 && Number(perPlate) > 0 ? `${Number(copies) * Number(perPlate)} part(s) in total` : ''}
          </span>
        </div>
      </form>

      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Recent Quick Prints</h2>
      {list?.project && (projectStatus === 'paused' || projectStatus === 'draft') && (
        <div style={{ background: '#78350f', border: '1px solid #92400e', borderRadius: 8, padding: '8px 14px', marginBottom: 10, color: '#fbbf24', fontSize: 13 }}>
          The Quick prints project is {projectStatus}, so nothing here will start. Set it to Active on the <Link to="/projects" style={{ color: '#fde68a' }}>Projects</Link> page.
        </div>
      )}
      {!list && <div style={{ color: '#64748b' }}>Loading…</div>}
      {list && list.parts.length === 0 && <div style={{ color: '#475569', fontSize: 13 }}>No quick prints yet.</div>}
      {list && list.parts.map(p => {
        const text = statusText(p, projectStatus);
        const removable = p.active_jobs.length === 0 && p.completed_qty === 0 && p.status !== 'closed';
        return (
          <div key={p.id} style={{
            background: '#131720', border: '1px solid #1e2433', borderRadius: 8, padding: '10px 14px', marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0' }}>{p.name}</div>
              <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.gcode ? `${p.gcode.printer_model.toUpperCase()} · ${p.gcode.filename}` : 'no file'}
              </div>
            </div>
            <span style={{ fontSize: 13, color: '#94a3b8', minWidth: 70 }}>{p.completed_qty} / {p.target_qty}</span>
            <span style={{ fontSize: 13, color: statusColor(text), flex: '1 1 200px' }}>{text}</span>
            {removable && (
              <button onClick={() => removePart(p)} style={btn('transparent', '#f87171')}>Remove</button>
            )}
          </div>
        );
      })}

      {toastEl}
      {confirmModal}
    </div>
  );
}
