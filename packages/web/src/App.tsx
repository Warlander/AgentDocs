import { useEffect, useMemo, useRef, useState } from 'react';
import { html as diff2html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

interface Doc {
  slug: string;
  project: string;
  title: string;
  created: string;
  latestSha: string | null;
}

interface Version {
  sha: string;
  date: string;
  message: string;
}

const docKey = (d: { project: string; slug: string }) => `${d.project}/${d.slug}`;

const SEEN_KEY = 'agentdocs-seen';

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
  const [project, setProject] = useState('');
  const [selected, setSelected] = useState<Doc | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [sha, setSha] = useState('');
  const [diffing, setDiffing] = useState(false);
  const [diffRange, setDiffRange] = useState({ from: '', to: '' });
  const [diffView, setDiffView] = useState('');
  const [docsPort, setDocsPort] = useState(3001);
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef<() => void>(() => {});
  const prevShas = useRef(new Map<string, string | null>());

  const load = async (query: string, proj: string) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (proj) params.set('project', proj);
    const res = await fetch('/api/docs?' + params);
    setDocs(await res.json());
  };
  loadRef.current = () => load(q, project);

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
      }
    }
    prevShas.current = new Map(docs.map(d => [docKey(d), d.latestSha]));
  }, [docs]);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => setDocsPort(c.docsPort));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(q, project), 200);
    return () => clearTimeout(t);
  }, [q, project]);

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

  const upload = async (file: File) => {
    const proj = prompt('Project name:', project || 'misc');
    if (proj === null) return;
    const form = new FormData();
    form.append('file', file);
    form.append('project', proj);
    await fetch('/api/docs', { method: 'POST', body: form });
    await load(q, project);
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Doc[]>();
    for (const d of [...docs].sort((a, b) => b.created.localeCompare(a.created))) {
      map.set(d.project, [...(map.get(d.project) ?? []), d]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [docs]);

  const projects = useMemo(() => [...new Set(docs.map(d => d.project))].sort(), [docs]);
  const origin = `${location.protocol}//${location.hostname}:${docsPort}`;

  return (
    <div className="flex h-screen bg-neutral-900 text-neutral-200 text-sm">
      <aside className="w-64 shrink-0 flex flex-col border-r border-neutral-700">
        <div className="p-2 space-y-2 border-b border-neutral-700">
          <input
            ref={searchRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search  ( / )"
            className="w-full bg-neutral-800 rounded px-2 py-1 outline-none focus:ring-1 ring-neutral-500"
          />
          <div className="flex gap-2">
            <select
              value={project}
              onChange={e => setProject(e.target.value)}
              className="flex-1 bg-neutral-800 rounded px-1 py-1"
            >
              <option value="">All projects</option>
              {projects.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button
              onClick={() => fileRef.current?.click()}
              className="bg-neutral-700 hover:bg-neutral-600 rounded px-3"
            >
              Upload
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".html,.htm"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto pb-4">
          {grouped.map(([proj, list]) => (
            <ProjectGroup key={proj} name={proj} docs={list} selected={selected} unread={unread} onSelect={select} />
          ))}
          {docs.length === 0 && <p className="px-3 py-4 text-neutral-500">No documents</p>}
        </div>
      </aside>

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
                key={`${selected.slug}:${sha}`}
                sandbox="allow-scripts"
                src={`${origin}/${selected.project}/${selected.slug}${sha ? `?sha=${sha}` : ''}`}
                className="flex-1 bg-white"
                title={selected.title}
              />
            )}
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-neutral-500">
            Select a document — or upload one
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectGroup({ name, docs, selected, unread, onSelect }: {
  name: string;
  docs: Doc[];
  selected: Doc | null;
  unread: Map<string, 'new' | 'upd'>;
  onSelect: (d: Doc) => void;
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
            className={`w-full text-left px-4 py-1 truncate hover:bg-neutral-800 flex items-center gap-1.5 ${
              selected?.slug === d.slug ? 'bg-neutral-800 text-white' : ''
            }`}
          >
            {state && (
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${state === 'new' ? 'bg-green-400' : 'bg-amber-400'}`}
                title={state === 'new' ? 'New document' : 'Updated since last viewed'}
              />
            )}
            <span className="truncate">{d.title}</span>
          </button>
        );
      })}
    </div>
  );
}
