import GiphyAttribution from './GiphyAttribution';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FilmIcon } from '@heroicons/react/16/solid';
import { FaceSmileIcon } from '@heroicons/react/24/outline';
import { api } from './api';

const EmojiCatalog = lazy(() => import('./EmojiCatalog'));
type Gif = { id: string; description: string; preview: string; url: string; pageUrl: string; creator: string };

export default function MediaPicker({ workspaceId, onEmoji, onGif }: { workspaceId: string; onEmoji: (value: string) => void; onGif: (url: string, source?: 'giphy' | 'link', attribution?: { pageUrl: string; creator: string }) => Promise<void> }) {
  const [tab, setTab] = useState<'emoji' | 'gifs'>('emoji');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inserting, setInserting] = useState(false);
  const cache = useRef(new Map<string, Gif[]>());

  useEffect(() => {
    if (tab !== 'gifs') return;
    let active = true;
    void api<{ enabled: boolean }>(`/workspaces/${workspaceId}/gifs/config`).then((result) => {
      if (active) setConfigured(result.enabled);
    }).catch(() => { if (active) setConfigured(false); });
    return () => { active = false; };
  }, [tab, workspaceId]);

  useEffect(() => {
    if (tab !== 'gifs' || !configured) return;
    if (query.trim().length === 1) { setGifs([]); setLoading(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const phrase = query.trim().slice(0, 50);
        const cached = cache.current.get(phrase);
        if (cached) { setGifs(cached); return; }
        const data = await api<Array<{ id: string; title: string; preview: string; url: string; page_url: string; creator: string }>>(`/workspaces/${workspaceId}/gifs/search?q=${encodeURIComponent(phrase)}`, { signal: controller.signal });
        const results = data.map((item) => ({ id: item.id, description: item.title, preview: item.preview, url: item.url, pageUrl: item.page_url, creator: item.creator }));
        if (!controller.signal.aborted) { cache.current.set(phrase, results); setGifs(results); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not search GIFs.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 550 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tab, query, configured, workspaceId]);

  async function chooseGif(gifUrl: string, source: 'giphy' | 'link' = 'link', attribution?: { pageUrl: string; creator: string }) {
    if (inserting) return;
    setInserting(true); setError('');
    try { await onGif(gifUrl, source, attribution); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add GIF.'); }
    finally { setInserting(false); }
  }

  return <div className="media-picker" role="dialog" aria-label="Emoji and GIF picker">
    <div className="media-picker-tabs" role="tablist" aria-label="Choose media">
      <button type="button" role="tab" aria-selected={tab === 'emoji'} className={tab === 'emoji' ? 'active' : ''} onClick={() => setTab('emoji')}><FaceSmileIcon /> Emoji</button>
      <button type="button" role="tab" aria-selected={tab === 'gifs'} className={tab === 'gifs' ? 'active' : ''} onClick={() => setTab('gifs')}><FilmIcon /> GIFs</button>
    </div>
    {tab === 'emoji' ? <div className="media-picker-emoji" role="tabpanel"><Suspense fallback={<div className="media-picker-empty">Loading emoji…</div>}><EmojiCatalog onSelect={onEmoji} /></Suspense></div> : <div className="media-picker-gifs" role="tabpanel">
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search GIPHY" aria-label="Search GIFs" autoFocus />
      {loading && <p className="media-picker-status">Searching GIFs…</p>}
      {!loading && configured && query.trim().length === 1 && <p className="media-picker-status">Type one more letter to search GIFs.</p>}
      {!loading && configured && query.trim().length !== 1 && gifs.length === 0 && <p className="media-picker-status">No GIFs found. Try another search.</p>}
      {!loading && configured === false && <p className="media-picker-status">GIF search is being set up. You can still add a direct GIF link below.</p>}
      <div className="media-picker-gif-grid">{gifs.map((gif) => <button type="button" key={gif.id} title={gif.description} aria-label={`Add ${gif.description}`} disabled={inserting} onClick={() => void chooseGif(gif.url, 'giphy', { pageUrl: gif.pageUrl, creator: gif.creator })}><img src={gif.preview} alt={gif.description} loading="lazy" /></button>)}</div>
      <div className="media-picker-gif-url"><label htmlFor="media-gif-link">Add a GIF link</label><div><input id="media-gif-link" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a Tenor or GIPHY GIF URL" /><button type="button" disabled={!url.trim() || inserting} onClick={() => void chooseGif(url.trim())}>Add</button></div></div>
      {error && <p className="media-picker-error" role="alert">{error}</p>}
      {configured && <div className="media-picker-credit"><GiphyAttribution /></div>}
    </div>}
  </div>;
}
