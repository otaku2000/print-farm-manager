import { useState, useEffect } from 'react';

// Live AMS contents of a Bambu printer, as reported by GET /api/printers/loaded-filament
// (list) and GET /api/printers/:id/loaded-filament (one printer). Slot numbers are shown
// 1-based, as on the printer screen. The tray feeding the nozzle is outlined in blue.

function remainColor(pct) {
  if (pct <= 10) return '#ef4444';
  if (pct <= 25) return '#f59e0b';
  return '#22c55e';
}

function Swatch({ color, empty, size = 10 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: 2, flexShrink: 0, display: 'inline-block',
      background: !empty && color ? `#${color}` : 'transparent',
      border: '1px solid #2d3748',
    }} />
  );
}

// Compact chip for the Printers list: swatch, slot, product name, and percent left.
function FilamentChip({ label, tray, active }) {
  const empty = !tray.type;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: '#0f1218',
      border: `1px solid ${active ? '#3b82f6' : '#1e2433'}`,
      borderRadius: 4, padding: '2px 7px',
      fontSize: 11, color: empty ? '#475569' : '#cbd5e1',
      whiteSpace: 'nowrap',
    }}>
      <Swatch color={tray.color} empty={empty} />
      <span style={{ color: '#64748b', fontWeight: 700 }}>{label}</span>
      {empty ? 'empty' : tray.name}
      {tray.remain != null && (
        <span style={{ color: remainColor(tray.remain), fontWeight: 600 }}>{tray.remain}%</span>
      )}
    </span>
  );
}

// Nozzle id 0 is the right nozzle and 1 the left on a two-nozzle printer (Bambu Studio's
// MAIN/DEPUTY extruder ids, see server/drivers/bambu-nozzles.js).
function nozzleSide(id, count) {
  if (count <= 1) return '';
  if (id === 0) return 'Right';
  if (id === 1) return 'Left';
  return `#${id}`;
}

function mm(d) {
  return `${Number(Number(d).toFixed(2))} mm`;
}

// Compact nozzle chip for the Printers list: "0.4 mm", or "R 0.4 mm · L 0.6 mm".
function NozzleChip({ nozzles }) {
  if (!nozzles || nozzles.length === 0) return null;
  const text = nozzles
    .map(n => nozzles.length > 1 ? `${nozzleSide(n.id, nozzles.length).charAt(0)} ${mm(n.diameter)}` : mm(n.diameter))
    .join(' · ');
  return (
    <span
      title={nozzles.map(n => `${nozzleSide(n.id, nozzles.length) || 'Nozzle'}: ${mm(n.diameter)}${n.type ? ` (${n.type})` : ''}`).join('\n')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: '#0f1218', border: '1px solid #1e2433', borderRadius: 4,
        padding: '2px 7px', fontSize: 11, color: '#cbd5e1', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: '#64748b', fontWeight: 700 }}>Nozzle</span>
      {text}
    </span>
  );
}

export function LoadedFilamentChips({ filament }) {
  if (!filament) {
    return <span style={{ fontSize: 11, color: '#475569' }}>AMS not reported yet</span>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <NozzleChip nozzles={filament.nozzles} />
      <span style={{ fontSize: 10, fontWeight: 700, color: '#475569', letterSpacing: '0.06em' }}>LOADED</span>
      {filament.trays.map(t => (
        <FilamentChip key={t.slot} label={t.slot + 1} tray={t} active={t.slot === filament.active_slot} />
      ))}
      {filament.external && (
        <FilamentChip label="Ext" tray={{ ...filament.external, name: filament.external.type, remain: null }} active={filament.active_slot === -1} />
      )}
    </div>
  );
}

// One tile per tray for the printer detail page, with a spool level bar.
function TrayTile({ label, tray, active }) {
  const empty = !tray.type;
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 130,
      background: '#0f1218',
      border: `1px solid ${active ? '#3b82f6' : '#1e2433'}`,
      borderRadius: 7, padding: '10px 12px',
      opacity: empty ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Swatch color={tray.color} empty={empty} size={14} />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>Slot {label}</span>
        {active && <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: '#60a5fa' }}>FEEDING</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: empty ? '#475569' : '#e2e8f0', marginBottom: 8 }}>
        {empty ? 'Empty' : tray.name}
        {!empty && tray.name !== tray.type && (
          <span style={{ fontSize: 11, color: '#64748b', fontWeight: 400 }}> ({tray.type})</span>
        )}
      </div>
      {!empty && (tray.remain != null ? (
        <div>
          <div style={{ height: 6, background: '#1e2433', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${tray.remain}%`, height: '100%', background: remainColor(tray.remain) }} />
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{tray.remain}% left</div>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: '#475569' }}>Level not reported (needs a Bambu RFID spool)</div>
      ))}
    </div>
  );
}

// Card for PrinterDetail. Polls every 15 s; background poll errors are swallowed.
export function LoadedFilamentPanel({ printerId }) {
  const [filament, setFilament] = useState(undefined);
  const [nozzles, setNozzles] = useState(null);

  useEffect(() => {
    const load = () => fetch(`/api/printers/${printerId}/loaded-filament`)
      .then(r => r.json())
      .then(body => { setFilament(body.filament ?? null); setNozzles(body.nozzles ?? null); })
      .catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [printerId]);

  return (
    <div style={{
      background: '#131720', border: '1px solid #1e2433',
      borderRadius: 8, padding: '14px 20px', marginBottom: 24,
    }}>
      {nozzles && nozzles.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Nozzle{nozzles.length > 1 ? 's' : ''}
          </span>
          {nozzles.map(n => (
            <span key={n.id} style={{ fontSize: 13, color: '#e2e8f0' }}>
              {nozzles.length > 1 && <span style={{ color: '#64748b' }}>{nozzleSide(n.id, nozzles.length)}: </span>}
              <span style={{ fontWeight: 600 }}>{mm(n.diameter)}</span>
              {n.type && <span style={{ fontSize: 11, color: '#64748b' }}> ({n.type})</span>}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
        Loaded filament (live from AMS)
      </div>
      {filament === undefined && <span style={{ fontSize: 12, color: '#475569' }}>Loading…</span>}
      {filament === null && <span style={{ fontSize: 12, color: '#475569' }}>The printer has not reported its AMS yet.</span>}
      {filament && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {filament.trays.map(t => (
            <TrayTile key={t.slot} label={t.slot + 1} tray={t} active={t.slot === filament.active_slot} />
          ))}
          {filament.external && (
            <TrayTile label="Ext" tray={{ ...filament.external, name: filament.external.type, remain: null }} active={filament.active_slot === -1} />
          )}
        </div>
      )}
    </div>
  );
}
