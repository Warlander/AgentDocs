import { useEffect, useMemo, useRef, useState } from 'react';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

interface Doc {
  slug: string;
  project: string;
  title: string;
  created: string;
  latestSha: string | null;
  favorite: boolean;
}

interface Version {
  sha: string;
  date: string;
  message: string;
}

interface Settings {
  vaultDir: string;
  defaultProject: string;
  gitUserName: string;
  gitUserEmail: string;
}

const docKey = (d: { project: string; slug: string }) => `${d.project}/${d.slug}`;

const SEEN_KEY = 'agentdocs-seen';
const SIDEBAR_KEY = 'agentdocs-sidebar-width';
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 600;

function loadSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function drawFavicon(unread: number) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#404040';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, 14);
  ctx.fill();
  ctx.fillStyle = '#e5e5e5';
  ctx.fillRect(20, 14, 24, 30);
  ctx.fillStyle = '#404040';
  for (let y = 19; y < 40; y += 6) ctx.fillRect(23, y, 18, 2);
  if (unread > 0) {
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.arc(46, 44, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(unread > 9 ? '9+' : String(unread), 46, 46);
  }
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL('image/png');
}

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Doc | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [sha, setSha] = useState('');
  const [diffing, setDiffing] = useState(false);
  const [diffRange, setDiffRange] = useState({ from: '', to: '' });
  const [diffView, setDiffView] = useState('');
  const [docsPort, setDocsPort] = useState(3001);
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [notice, setNotice] = useState('');
  const [sidebarW, setSidebarW] = useState(() => {
    const v = Number(localStorage.getItem(SIDEBAR_KEY));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 256;
  });
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsOrig = useRef<Settings | null>(null);
  const loadRef = useRef<() => void>(() => {});
  const prevShas = useRef(new Map<string, string | null>());

  const load = async (query: string) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const res = await fetch('/api/docs?' + params);
    setDocs(await res.json());
  };
  loadRef.current = () => load(q);

  const markSeen = (d: Doc) => {
    if (!d.latestSha) return;
    setSeen(prev => {
      const next = { ...prev, [docKey(d)]: d.latestSha! };
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const unread = useMemo(() => {
    const m = new Map<string, 'new' | 'upd'>();
    for (const d of docs) {
      if (!d.latestSha) continue;
      const s = seen[docKey(d)];
      if (s === undefined) m.set(docKey(d), 'new');
      else if (s !== d.latestSha) m.set(docKey(d), 'upd');
    }
    return m;
  }, [docs, seen]);

  useEffect(() => {
    document.title = unread.size ? `(${unread.size}) Vault` : 'Vault';
    drawFavicon(unread.size);
  }, [unread]);

  // Snap to latest + mark read when the selected doc is updated while open
  useEffect(() => {
    const cur = selected && docs.find(d => docKey(d) === docKey(selected));
    if (cur) {
      const k = docKey(cur);
      const prev = prevShas.current.get(k);
      if (prev !== undefined && cur.latestSha !== prev) {
        setSha('');
        markSeen(cur);
        fetch(`/api/docs/${cur.slug}/versions`).then(r => r.json()).then(setVersions);
      }
    }
    prevShas.current = new Map(docs.map(d => [docKey(d), d.latestSha]));
  }, [docs]);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => setDocsPort(c.docsPort));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const t = setTimeout(() => load(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const t = setInterval(() => loadRef.current(), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!diffRange.from || !diffRange.to || !selected) return;
    fetch(`/api/docs/${selected.slug}/diff?from=${diffRange.from}&to=${diffRange.to}`)
      .then(r => r.text())
      .then(text => setDiffView(diff2html(text, { drawFileList: false, matching: 'lines', outputFormat: 'side-by-side' })));
  }, [diffRange, selected]);

  const toggleFavorite = async (e: React.MouseEvent, d: Doc) => {
    e.stopPropagation();
    const favorite = !d.favorite;
    setDocs(prev => prev.map(x => x.slug === d.slug ? { ...x, favorite } : x));
    const res = await fetch(`/api/docs/${d.slug}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite }),
    });
    if (!res.ok) await load(q);
  };

  const startSidebarDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = sidebarW;
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) =>
      setSidebarW(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const select = async (d: Doc) => {
    setSelected(d);
    markSeen(d);
    setSha('');
    setDiffing(false);
    setDiffView('');
    setDiffRange({ from: '', to: '' });
    const res = await fetch(`/api/docs/${d.slug}/versions`);
    setVersions(await res.json());
  };

  const openSettings = async () => {
    setSettingsError('');
    const res = await fetch('/api/settings');
    const s: Settings = await res.json();
    settingsOrig.current = s;
    setSettings(s);
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!settings) return;
    const post = (body: Record<string, string>) =>
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    // vaultDir swaps the vault server-side, so it must be sent on its own —
    // the other fields then apply to the new vault.
    if (settings.vaultDir !== settingsOrig.current?.vaultDir) {
      const res = await post({ vaultDir: settings.vaultDir });
      if (!res.ok) {
        setSettingsError((await res.json()).error ?? 'failed to change vault location');
        return;
      }
      const { swapped } = await res.json();
      if (swapped) {
        setSelected(null);
        setNotice('Vault location changed');
      }
    }
    await post({
      defaultProject: settings.defaultProject,
      gitUserName: settings.gitUserName,
      gitUserEmail: settings.gitUserEmail,
    });
    setSettingsOpen(false);
    setSettings(null);
    await load(q);
  };

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarW));
  }, [sidebarW]);

  const grouped = useMemo(() => {
    const map = new Map<string, Doc[]>();
    for (const d of [...docs].sort((a, b) => b.created.localeCompare(a.created))) {
      map.set(d.project, [...(map.get(d.project) ?? []), d]);
    }
    // newest doc per project before pinning, so favorites don't affect project order
    const newest = new Map([...map.entries()].map(([p, list]) => [p, list[0]?.created ?? '']));
    for (const list of map.values()) list.sort((a, b) => Number(b.favorite) - Number(a.favorite));
    return [...map.entries()].sort((a, b) => newest.get(b[0])!.localeCompare(newest.get(a[0])!));
  }, [docs]);

  const origin = `${location.protocol}//${location.hostname}:${docsPort}`;
  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-200 text-sm">
      <aside style={{ width: sidebarW }} className="shrink-0 flex flex-col border-r border-neutral-700">
        <div className="p-2 border-b border-neutral-700 flex gap-2">
          <input
            ref={searchRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search  ( / )"
            className="flex-1 min-w-0 bg-neutral-800 rounded px-2 py-1 outline-none focus:ring-1 ring-neutral-500"
          />
          <button
            onClick={openSettings}
            title="Settings"
            className="bg-neutral-700 hover:bg-neutral-600 rounded px-2"
          >
            ⚙
          </button>
        </div>
        <div className="flex-1 overflow-y-auto pb-4">
          {grouped.map(([proj, list]) => (
            <ProjectGroup key={proj} name={proj} docs={list} selected={selected} unread={unread} onSelect={select} onToggleFavorite={toggleFavorite} />
          ))}
          {docs.length === 0 && <p className="px-3 py-4 text-neutral-500">No documents</p>}
        </div>
      </aside>

      <div
        onPointerDown={startSidebarDrag}
        className={`w-1 shrink-0 cursor-col-resize ${dragging ? 'bg-neutral-500' : 'hover:bg-neutral-600'}`}
      />

      <main className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="flex items-center gap-2 p-2 border-b border-neutral-700">
              <span className="font-medium truncate">{selected.title}</span>
              <span className="text-neutral-500 text-xs">{selected.project}/{selected.slug}</span>
              <div className="ml-auto flex items-center gap-2">
                {diffing && (
                  <>
                    <select
                      value={diffRange.from}
                      onChange={e => setDiffRange(r => ({ ...r, from: e.target.value }))}
                      className="bg-neutral-800 rounded px-1 py-1"
                    >
                      <option value="">from…</option>
                      {versions.map(v => (
                        <option key={v.sha} value={v.sha}>{v.sha.slice(0, 7)} {v.message}</option>
                      ))}
                    </select>
                    <select
                      value={diffRange.to}
                      onChange={e => setDiffRange(r => ({ ...r, to: e.target.value }))}
                      className="bg-neutral-800 rounded px-1 py-1"
                    >
                      <option value="">to…</option>
                      {versions.map(v => (
                        <option key={v.sha} value={v.sha}>{v.sha.slice(0, 7)} {v.message}</option>
                      ))}
                    </select>
                  </>
                )}
                <button
                  onClick={() => { setDiffing(!diffing); setDiffView(''); setDiffRange({ from: '', to: '' }); }}
                  className={`rounded px-2 py-1 ${diffing ? 'bg-neutral-600' : 'bg-neutral-800 hover:bg-neutral-700'}`}
                >
                  Diff
                </button>
                <select
                  value={sha}
                  onChange={e => setSha(e.target.value)}
                  className="bg-neutral-800 rounded px-1 py-1"
                >
                  <option value="">latest</option>
                  {versions.map(v => (
                    <option key={v.sha} value={v.sha}>{v.sha.slice(0, 7)} {v.message}</option>
                  ))}
                </select>
              </div>
            </div>
            {diffing && diffView ? (
              <div className="flex-1 overflow-auto bg-white" dangerouslySetInnerHTML={{ __html: diffView }} />
            ) : (
              <iframe
                key={`${selected.slug}:${sha || docs.find(d => docKey(d) === docKey(selected))?.latestSha || ''}`}
                sandbox="allow-scripts"
                src={`${origin}/${selected.project}/${selected.slug}${sha ? `?sha=${sha}` : ''}`}
                className={`flex-1 bg-white ${dragging ? 'pointer-events-none' : ''}`}
                title={selected.title}
              />
            )}
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-neutral-500">
            Select a document
          </div>
        )}
      </main>

      {notice && (
        <div className="fixed bottom-4 right-4 bg-neutral-700 rounded px-3 py-2 shadow-lg">
          {notice}
        </div>
      )}

      {settingsOpen && settings && (
        <div
          className="fixed inset-0 bg-black/60 grid place-items-center"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="bg-neutral-800 rounded p-4 w-96 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-medium">Settings</h2>
            {([
              ['vaultDir', 'Vault location'],
              ['defaultProject', 'Default project'],
              ['gitUserName', 'Git user name'],
              ['gitUserEmail', 'Git user email'],
            ] as const).map(([key, label]) => (
              <label key={key} className="block text-xs text-neutral-400">
                {label}
                <input
                  value={settings[key]}
                  onChange={e => setSettings({ ...settings, [key]: e.target.value })}
                  className="mt-1 w-full bg-neutral-900 rounded px-2 py-1 text-sm text-neutral-200 outline-none focus:ring-1 ring-neutral-500"
                />
              </label>
            ))}
            {settings.vaultDir !== settingsOrig.current?.vaultDir && (
              <p className="text-xs text-amber-400">
                Changing vault location switches immediately — documents stay in their current vault.
              </p>
            )}
            {settingsError && <p className="text-xs text-red-400">{settingsError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setSettingsOpen(false)}
                className="bg-neutral-700 hover:bg-neutral-600 rounded px-3 py-1"
              >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                className="bg-neutral-600 hover:bg-neutral-500 rounded px-3 py-1"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectGroup({ name, docs, selected, unread, onSelect, onToggleFavorite }: {
  name: string;
  docs: Doc[];
  selected: Doc | null;
  unread: Map<string, 'new' | 'upd'>;
  onSelect: (d: Doc) => void;
  onToggleFavorite: (e: React.MouseEvent, d: Doc) => void;
}) {
  const [open, setOpen] = useState(true);
  const unreadCount = docs.filter(d => unread.has(docKey(d))).length;
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-2 py-1.5 text-xs uppercase tracking-wide text-neutral-400 hover:bg-neutral-800"
      >
        {open ? '▾' : '▸'} {name} <span className="text-neutral-600">({docs.length})</span>
        {unreadCount > 0 && (
          <span className="ml-1 px-1.5 rounded-full bg-amber-500 text-neutral-900 font-bold normal-case">
            {unreadCount}
          </span>
        )}
      </button>
      {open && docs.map(d => {
        const state = unread.get(docKey(d));
        return (
          <button
            key={d.slug}
            onClick={() => onSelect(d)}
            className={`group w-full text-left px-4 py-1 truncate hover:bg-neutral-800 flex items-center gap-1.5 ${
              selected?.slug === d.slug
                ? 'bg-neutral-800 text-white'
                : d.favorite
                  ? 'bg-amber-400/[0.07] hover:bg-amber-400/[0.12]'
                  : ''
            }`}
          >
            {state && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${state === 'new' ? 'bg-green-400' : 'bg-amber-400'}`}
                title={state === 'new' ? 'New document' : 'Updated since last viewed'}
              />
            )}
            <span className="truncate flex-1">{d.title}</span>
            <span
              onClick={e => onToggleFavorite(e, d)}
              title={d.favorite ? 'Un-favorite' : 'Favorite'}
              className={d.favorite
                ? 'shrink-0 text-amber-400'
                : 'shrink-0 text-neutral-400 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-60'}
            >
              {d.favorite ? '★' : '☆'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
