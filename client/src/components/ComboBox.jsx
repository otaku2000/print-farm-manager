import { useState, useRef, useEffect } from 'react';

// A text input with a dropdown of known values: click or focus it to see the list, type to
// filter it, pick with the mouse or the arrow keys and Enter. Typing a value that is not in
// the list is still allowed (a new Group, for example). value and onChange work on the text,
// like a plain input; onChange receives the string.
export default function ComboBox({ value, onChange, options, placeholder, disabled, style, inputStyle }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [typed, setTyped] = useState(false);
  const listRef = useRef(null);

  const text = value || '';
  // Right after opening (or picking) show everything; once the user types, filter by it.
  const query = typed ? text.trim().toLowerCase() : '';
  const shown = options.filter(o => !query || o.toLowerCase().includes(query));

  useEffect(() => { setHighlight(-1); }, [query, open]);

  useEffect(() => {
    if (highlight < 0 || !listRef.current) return;
    listRef.current.children[highlight]?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  function pick(option) {
    onChange(option);
    setTyped(false);
    setOpen(false);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight(h => Math.min(h + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && open && highlight >= 0 && shown[highlight]) {
      e.preventDefault();
      pick(shown[highlight]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        value={text}
        onChange={e => { onChange(e.target.value); setTyped(true); setOpen(true); }}
        onFocus={() => { setTyped(false); setOpen(true); }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', paddingRight: 26 }}
      />
      <span
        aria-hidden="true"
        onMouseDown={e => {
          // Keep focus in the input; toggle the list.
          e.preventDefault();
          if (disabled) return;
          e.currentTarget.previousSibling.focus();
          setTyped(false);
          setOpen(o => !o);
        }}
        style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          fontSize: 10, color: '#64748b', cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
        }}
      >
        ▼
      </span>
      {open && !disabled && (
        <div
          ref={listRef}
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 50,
            background: '#0f1218', border: '1px solid #2d3748', borderRadius: 6,
            maxHeight: 220, overflowY: 'auto', boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          }}
        >
          {shown.length === 0 && (
            <div style={{ padding: '7px 10px', fontSize: 12, color: '#64748b' }}>
              {text.trim() ? `No match: "${text.trim()}" will be added as new` : 'None yet'}
            </div>
          )}
          {shown.map((o, i) => (
            <div
              key={o}
              role="option"
              aria-selected={o === text}
              // mousedown, not click: it fires before the input's blur closes the list.
              onMouseDown={e => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                padding: '7px 10px', fontSize: 13, cursor: 'pointer',
                color: o === text ? '#93c5fd' : '#e2e8f0',
                background: i === highlight ? '#1e2433' : 'transparent',
              }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
