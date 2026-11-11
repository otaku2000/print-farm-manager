import { useState, useEffect } from 'react';

// Printer model ids ("h2d", "pxl") are stored lowercase; operators know them by the label
// set in Settings > Printer Models ("H2D", "Prusa XL"). This hook returns a function that
// turns an id into its label, falling back to the id in upper case while the list loads or
// for a model with no label. The list is fetched once and shared by every page.

let cache = null;
let pending = null;

function loadModels() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch('/api/models')
      .then(r => r.json())
      .then(list => { cache = Object.fromEntries((Array.isArray(list) ? list : []).map(m => [m.model_id, m.label])); return cache; })
      .catch(() => { pending = null; return {}; });
  }
  return pending;
}

export function useModelLabel() {
  const [labels, setLabels] = useState(cache || {});
  useEffect(() => {
    let live = true;
    loadModels().then(l => { if (live) setLabels(l); });
    return () => { live = false; };
  }, []);
  return (id) => (id ? labels[id] || String(id).toUpperCase() : '');
}
