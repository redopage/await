import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node as ProseNode } from 'prosemirror-model';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Channel, Member } from '../shared/types';
import { api } from './api';
import { messageSchema as schema } from './messageRichText';
import { currentSuggestion, insertTag, messageEditorPlugins, suggestionItems, type ChannelTask, type Suggestion, type SuggestionItem } from './messageEditing';

type Options = {
  workspaceId: string;
  channelId: string;
  // DMs have no Kanban cards to link.
  dm: boolean;
  channels: Channel[];
  // Read once, when the editor mounts.
  doc: () => ProseNode | undefined;
  // The editor's own keys run after the suggestion keys and ahead of messageEditorPlugins(). Their names are read
  // once; each call uses the latest render's handler, so closures never go stale.
  keys: Record<string, Command>;
  attributes: Record<string, string>;
  editable?: () => boolean;
  onDocChange: (doc: ProseNode) => void;
};

export type MessageEditor = ReturnType<typeof useMessageEditor>;

// One ProseMirror message editor with @people and #channel/card suggestions, shared by the composer and the inline
// message editor.
export default function useMessageEditor(options: Options) {
  const { workspaceId, channelId, dm, channels } = options;
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [selected, setSelected] = useState(0);
  const [marks, setMarks] = useState<string[]>([]);
  const members = useQuery({ queryKey: ['channel-members', workspaceId, channelId], queryFn: () => api<Member[]>(`/workspaces/${workspaceId}/channels/${channelId}/members`), staleTime: 30000 });
  const tasks = useQuery({ queryKey: ['channel-tasks', workspaceId, channelId], queryFn: () => api<ChannelTask[]>(`/workspaces/${workspaceId}/collab/tasks?channel=${channelId}`), staleTime: 30000, enabled: !dm });
  const sources = { members: members.data ?? [], channels, tasks: tasks.data ?? [] };
  // Keys and transactions run between renders, so the open suggestion and selection live here as well as in state.
  const live = useRef({ options, sources, suggestion: null as Suggestion | null, selected: 0 });
  live.current.options = options;
  live.current.sources = sources;

  const items = () => suggestionItems(live.current.suggestion, live.current.sources);
  const editable = () => live.current.options.editable?.() ?? true;

  function select(index: number) {
    live.current.selected = index;
    setSelected(index);
  }

  function close() {
    live.current.suggestion = null;
    setSuggestion(null);
  }

  function insert(item: SuggestionItem) {
    const editor = view.current;
    const match = live.current.suggestion;
    if (!editor || !match || !editable()) return;
    editor.dispatch(insertTag(editor.state, match, item));
    close();
    editor.focus();
  }

  const insertSelected: Command = () => {
    const item = items()[live.current.selected];
    if (!live.current.suggestion || !item) return false;
    insert(item);
    return true;
  };

  const move = (delta: number): Command => () => {
    const count = items().length;
    if (!live.current.suggestion || !count) return false;
    select((live.current.selected + delta + count) % count);
    return true;
  };

  // Puts a new state in the editor and brings the suggestions and pressed format buttons in line with it.
  function show(editor: EditorView, state: EditorState, docChanged: boolean) {
    editor.updateState(state);
    if (docChanged) live.current.options.onDocChange(state.doc);
    const next = currentSuggestion(state);
    live.current.suggestion = next;
    live.current.selected = 0;
    setSuggestion(next);
    setSelected(0);
    const { empty, from, to, $from } = state.selection;
    const active = empty ? (state.storedMarks ?? $from.marks()).map((mark) => mark.type) : Object.values(schema.marks).filter((type) => state.doc.rangeHasMark(from, to, type));
    setMarks(active.map((type) => type.name));
  }

  // Starts over with a new document, or an empty one, and a fresh undo history.
  function replace(doc?: ProseNode) {
    const editor = view.current;
    if (editor) show(editor, EditorState.create({ doc, schema, plugins: editor.state.plugins }), true);
  }

  useEffect(() => {
    if (!mount.current) return;
    const own = Object.fromEntries(Object.keys(live.current.options.keys).map((key): [string, Command] => [key, (state, dispatch, editorView) => live.current.options.keys[key]?.(state, dispatch, editorView) ?? false]));
    const editor = new EditorView(mount.current, {
      state: EditorState.create({ schema, doc: live.current.options.doc(), plugins: [
        // Enter or Tab inserts the selected suggestion, the arrows move through them and Escape closes them.
        keymap({ Enter: insertSelected, Tab: insertSelected, ArrowDown: move(1), ArrowUp: move(-1), Escape: () => { if (!live.current.suggestion) return false; close(); return true; } }),
        keymap(own),
        ...messageEditorPlugins(),
      ] }),
      editable,
      attributes: live.current.options.attributes,
      dispatchTransaction(transaction) { show(editor, editor.state.apply(transaction), transaction.docChanged); },
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);

  return {
    mount, view, members, tasks, suggestion, selected, marks,
    matches: suggestionItems(suggestion, sources),
    // Whether suggestions are open right now, for key handlers that run before the next render.
    suggesting: () => Boolean(live.current.suggestion),
    select, close, insert, replace,
  };
}

const formats = [
  { mark: 'strong', label: 'Bold', icon: <strong>B</strong> },
  { mark: 'em', label: 'Italic', icon: <em>I</em> },
  { mark: 'strike', label: 'Strikethrough', icon: <s>S</s> },
] as const;

// Bold, italic, strikethrough and inline code, pressed while the selection carries the mark.
export function FormatButtons({ editor, disabled }: { editor: MessageEditor; disabled?: boolean }) {
  const button = (mark: 'strong' | 'em' | 'strike' | 'code', label: string, icon: ReactNode, className = 'composer-format') => <button type="button" className={className} key={mark} aria-label={label} title={label} aria-pressed={editor.marks.includes(mark)} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => {
    const view = editor.view.current;
    if (!view) return;
    toggleMark(schema.marks[mark])(view.state, view.dispatch, view);
    view.focus();
  }}>{icon}</button>;
  return <>
    {formats.map((item) => button(item.mark, item.label, item.icon))}
    <span className="composer-tool-divider" />
    {button('code', 'Inline code', <>&lt;/&gt;</>, 'composer-format code')}
  </>;
}
