
// One registry per Bridge realm. Registrations belong to a plugin generation;
// unloading a shadowing registration restores the previous provider.
const custom = new Map();
const ns = 'http://www.w3.org/2000/svg';
export function iconApi(own, alive, iconNodes) {
  const owned = new Set();
  let cleanupRegistered = false;
  const remove = id => {
    const stack = custom.get(id);
    if (!stack) return;
    const next = stack.filter(record => !owned.has(record));
    for (const record of stack) if (owned.has(record)) owned.delete(record);
    if (next.length) custom.set(id, next); else custom.delete(id);
  };
  const getIcon = id => {
    const markup = custom.get(id)?.at(-1)?.markup;
    const nodes = iconNodes[String(id).replace(/^lucide-/, '')];
    if (markup == null && !nodes) return null;
    const svg = document.createElementNS(ns, 'svg');
    for (const [key,value] of Object.entries({xmlns:ns,width:24,height:24,viewBox:markup == null?'0 0 24 24':'0 0 100 100',fill:'none',stroke:'currentColor','stroke-width':2,'stroke-linecap':'round','stroke-linejoin':'round',class:'svg-icon'})) svg.setAttribute(key,String(value));
    if (markup != null) svg.innerHTML = markup;
    else for (const [tag,attrs] of nodes) {
      const child = document.createElementNS(ns,tag);
      for (const [key,value] of Object.entries(attrs)) if(key !== 'key') child.setAttribute(key,String(value));
      svg.append(child);
    }
    return svg;
  };
  return {
    getIcon,
    getIconIds: () => [...new Set([...Object.keys(iconNodes),...custom.keys()])],
    addIcon(id,markup) { alive(); if (!cleanupRegistered) { cleanupRegistered = true; own(() => { for (const key of [...custom.keys()]) remove(key); }); } remove(id); const record = {markup:String(markup)}; owned.add(record);custom.set(id,[...(custom.get(id)||[]),record]); },
    removeIcon(id) { alive();remove(id); },
    setIcon(el,id) { const svg=getIcon(id); el.replaceChildren(...(svg?[svg]:[]));el.dataset.icon=id; },
  };
}
