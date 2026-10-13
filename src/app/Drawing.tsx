import { useRef, useState } from 'react';
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import { useTheme } from './ThemeProvider';

export type DrawingScene = { type: 'excalidraw'; elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles };
type Props = { onCancel: () => void; onSave: (scene: Blob, preview: Blob) => Promise<void>; initialScene?: DrawingScene };

export default function Drawing({ onCancel, onSave, initialScene }: Props) {
  const { resolvedMode } = useTheme();
  const snapshot = useRef<{ elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles } | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!snapshot.current) return;
    setSaving(true);
    try {
      const scene = new Blob([JSON.stringify({ type: 'excalidraw', version: 2, source: 'await.chat', elements: snapshot.current.elements, appState: { viewBackgroundColor: snapshot.current.appState.viewBackgroundColor }, files: snapshot.current.files })], { type: 'application/vnd.excalidraw+json' });
      const preview = await exportToBlob({ elements: snapshot.current.elements, appState: { ...snapshot.current.appState, exportBackground: true }, files: snapshot.current.files, mimeType: 'image/png' });
      await onSave(scene, preview);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save drawing.'); }
    finally { setSaving(false); }
  }
  return <div className="drawing-modal" role="dialog" aria-modal="true" aria-label={initialScene ? 'Edit drawing' : 'New drawing'}>
    <div className="drawing-bar"><div><strong>{initialScene ? 'Edit drawing' : 'New drawing'}</strong><p>{initialScene ? 'Your updated version will appear in this thread.' : 'Sketch an idea, then share it in the conversation.'}</p></div><div className="flex gap-2"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="button" className="button primary" disabled={saving || !ready} onClick={save}>{saving ? 'Saving…' : initialScene ? 'Post update' : 'Post drawing'}</button></div></div>
    {error && <p className="error-banner">{error}</p>}
    <div className="drawing-canvas"><Excalidraw theme={resolvedMode} initialData={initialScene ? { elements: [...initialScene.elements], appState: { viewBackgroundColor: initialScene.appState?.viewBackgroundColor }, files: initialScene.files } : undefined} onChange={(elements, appState, files) => { snapshot.current = { elements, appState, files }; if (!ready) setReady(true); }} /></div>
  </div>;
}
