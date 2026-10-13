import { useEffect, useId, useRef, useState } from 'react';
import { TextSelection } from 'prosemirror-state';
import { splitListItem } from 'prosemirror-schema-list';
import type { Channel, ChatMessage, Member } from '../shared/types';
import { messageSchema as schema, parseMessage, serializeMessage } from './messageRichText';
import { startSuggestion } from './messageEditing';
import useMessageEditor, { FormatButtons } from './useMessageEditor';
import './messageEditor.css';

export default function InlineMessageEditor({ message, members, channels, workspaceId, onSave, onCancel }: {
  message: ChatMessage; members: Member[]; channels: Channel[]; workspaceId: string;
  onSave: (body: string) => Promise<void>; onCancel: () => void;
}) {
  const listId = useId();
  const initial = useRef(message.body);
  const savingNow = useRef(false);
  const [body, setBody] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editor = useMessageEditor({
    workspaceId, channelId: message.channel_id, dm: Boolean(channels.find((channel) => channel.id === message.channel_id)?.is_dm), channels,
    doc: () => parseMessage(initial.current, members, channels, message.tasks),
    keys: {
      Enter: splitListItem(schema.nodes.list_item),
      Escape: () => { if (!savingNow.current) onCancel(); return true; },
      'Mod-Enter': () => { void save(); return true; },
    },
    attributes: { role: 'textbox', 'aria-label': 'Edit message', 'aria-multiline': 'true', 'aria-autocomplete': 'list', 'aria-controls': listId, 'aria-expanded': 'false' },
    editable: () => !savingNow.current,
    onDocChange: (doc) => setBody(serializeMessage(doc)),
  });
  const { suggestion, selected, matches } = editor;

  async function save() {
    const view = editor.view.current;
    if (savingNow.current || !view) return;
    const next = view.state.doc.eq(parseMessage(initial.current, members, channels, message.tasks)) ? initial.current : serializeMessage(view.state.doc);
    if (!next.trim() || next.length > 12000) { setError('Use between 1 and 12,000 characters.'); return; }
    savingNow.current = true;
    setSaving(true); setError('');
    try { await onSave(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save. Your edit is still here.'); }
    finally { savingNow.current = false; setSaving(false); }
  }

  useEffect(() => {
    const view = editor.view.current;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.focus();
    const reveal = requestAnimationFrame(() => editor.mount.current?.closest('.inline-message-editor')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(reveal);
  }, []);

  useEffect(() => { editor.view.current?.setProps({ editable: () => !saving }); }, [saving]);
  useEffect(() => {
    const dom = editor.view.current?.dom;
    dom?.setAttribute('aria-expanded', String(Boolean(suggestion)));
    if (suggestion && matches[selected]) dom?.setAttribute('aria-activedescendant', `${listId}-${selected}`);
    else dom?.removeAttribute('aria-activedescendant');
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [suggestion, selected, matches.length, listId]);

  return <div className="inline-message-editor" aria-busy={saving} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (event.target !== editor.view.current?.dom && !saving) onCancel(); } }}>
    <div className="composer-formatting-row" role="toolbar" aria-label="Edit formatting">
      <FormatButtons editor={editor} disabled={saving} />
      <span className="composer-tool-divider" />
      <button type="button" className="composer-format" aria-label="Mention someone" disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => { const view = editor.view.current; if (view) { view.dispatch(startSuggestion(view.state, '@')); view.focus(); } }}>@</button>
    </div>
    <div className="inline-edit-content" ref={editor.mount} />
    {suggestion && <div className="inline-edit-suggestions" id={listId} role="listbox" aria-label={suggestion.kind === 'mention' ? 'Mention someone' : 'Link a channel or task'}>
      {matches.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} key={item.id} aria-selected={index === selected} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.insert(item)}>{suggestion.kind === 'mention' ? '@' : '#'}{item.label}{item.detail && <small> {item.detail}</small>}</button>)}
      {!matches.length && <p>{suggestion.kind === 'mention' && editor.members.isPending ? 'Loading members…' : suggestion.kind === 'mention' && editor.members.isError ? 'Members could not load.' : 'No matches.'}</p>}
    </div>}
    {error && <p className="composer-error" role="alert">{error}</p>}
    <div className="inline-edit-footer"><span>Esc to cancel · ⌘/Ctrl + Enter to save</span><div><button type="button" className="button secondary" disabled={saving} onClick={onCancel}>Cancel</button><button type="button" className="button primary" disabled={saving || !body.trim() || body.length > 12000} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button></div></div>
  </div>;
}
