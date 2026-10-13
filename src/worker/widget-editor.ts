import { Schema, Node as ProseNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    mention: {
      inline: true, group: 'inline', atom: true, attrs: { id: {}, label: {} },
      parseDOM: [{ tag: 'span[data-mention]', getAttrs: (node) => ({ id: (node as HTMLElement).dataset.mention, label: (node as HTMLElement).textContent?.replace(/^@/, '') }) }],
      toDOM: (node) => ['span', { class: 'composer-chip', 'data-mention': node.attrs.id, contenteditable: 'false' }, `@${node.attrs.label}`],
    },
    channel: {
      inline: true, group: 'inline', atom: true, attrs: { id: {}, label: {} },
      parseDOM: [{ tag: 'span[data-channel]', getAttrs: (node) => ({ id: (node as HTMLElement).dataset.channel, label: (node as HTMLElement).textContent?.replace(/^#/, '') }) }],
      toDOM: (node) => ['span', { class: 'composer-chip channel-chip', 'data-channel': node.attrs.id, contenteditable: 'false' }, `#${node.attrs.label}`],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
    code: { excludes: '_', parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  },
});

// A code span reads no backslash escapes, so its fence outgrows every backtick run inside it, and a
// space pads text that starts or ends with a backtick or with spaces at both ends.
function codeSpan(text: string): string {
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = /^`|`$|^ .* $/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function markdown(doc: ProseNode): string {
  const lines: string[] = [];
  doc.forEach((paragraph) => {
    let line = '';
    paragraph.forEach((node) => {
      if (node.type.name === 'mention') line += `<@${node.attrs.id}>`;
      else if (node.type.name === 'channel') line += `<#${node.attrs.id}>`;
      else if (node.type.name === 'hard_break') line += '\n';
      else {
        let text = node.text ?? '';
        if (node.marks.some((mark) => mark.type.name === 'code')) text = codeSpan(text);
        else {
          if (node.marks.some((mark) => mark.type.name === 'strong')) text = `**${text}**`;
          if (node.marks.some((mark) => mark.type.name === 'em')) text = `*${text}*`;
          if (node.marks.some((mark) => mark.type.name === 'strike')) text = `~~${text}~~`;
        }
        line += text;
      }
    });
    lines.push(line);
  });
  return lines.join('\n');
}

type Suggestion = { kind: 'mention' | 'channel'; query: string; from: number; to: number };
function suggestionAtCursor(view: EditorView): Suggestion | null {
  const selection = view.state.selection;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\ufffc');
  const match = before.match(/(?:^|\s)([@#])([^\s@#]{0,40})$/);
  return match ? { kind: match[1] === '@' ? 'mention' : 'channel', query: match[2].toLocaleLowerCase(), from: selection.from - match[2].length - 1, to: selection.from } : null;
}

function documentFromText(text: string): ProseNode {
  const lines = text.split('\n');
  return schema.nodes.doc.create(null, lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined)));
}

type Hooks = {
  onChange: () => void;
  onEnter: () => void;
  onMentionKey: (key: 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Escape') => boolean;
  suggestionsId?: string;
};

function createRichEditor(mount: HTMLElement, hooks: Hooks) {
  let editable = true;
  const view = new EditorView(mount, {
    state: EditorState.create({ schema, plugins: [
      keymap({
        Enter: () => { hooks.onEnter(); return true; },
        Tab: () => hooks.onMentionKey('Tab'),
        ArrowDown: () => hooks.onMentionKey('ArrowDown'),
        ArrowUp: () => hooks.onMentionKey('ArrowUp'),
        Escape: () => hooks.onMentionKey('Escape'),
        'Mod-Enter': () => { hooks.onEnter(); return true; },
        'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView()); return true; },
        'Mod-b': toggleMark(schema.marks.strong),
        'Mod-i': toggleMark(schema.marks.em),
        'Mod-z': undo,
        'Mod-Shift-z': redo,
      }), history(), keymap(baseKeymap),
    ] }),
    editable: () => editable,
    attributes: { role: 'textbox', 'aria-label': 'Write a message', 'aria-multiline': 'true', 'aria-autocomplete': 'list', 'aria-haspopup': 'listbox', 'aria-controls': hooks.suggestionsId ?? 'mentions' },
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      if (transaction.docChanged || transaction.selectionSet) hooks.onChange();
    },
  });
  return {
    dom: view.dom,
    focus: () => view.focus(),
    markdown: () => markdown(view.state.doc),
    isEmpty: () => !markdown(view.state.doc).trim(),
    snapshot: () => view.state.doc.toJSON(),
    restore: (doc: unknown) => {
      try { view.updateState(EditorState.create({ schema, doc: ProseNode.fromJSON(schema, doc), plugins: view.state.plugins })); }
      catch { view.updateState(EditorState.create({ schema, plugins: view.state.plugins })); }
      hooks.onChange();
    },
    setText: (text: string) => { view.updateState(EditorState.create({ schema, doc: documentFromText(text), plugins: view.state.plugins })); hooks.onChange(); },
    clear: () => { view.updateState(EditorState.create({ schema, plugins: view.state.plugins })); hooks.onChange(); },
    insertText: (text: string) => { view.dispatch(view.state.tr.insertText(text)); view.focus(); },
    currentSuggestion: () => suggestionAtCursor(view),
    insertSuggestion: (item: { id: string; label: string }) => {
      const match = suggestionAtCursor(view);
      if (!match) return;
      const node = schema.nodes[match.kind].create({ id: item.id, label: item.label });
      view.dispatch(view.state.tr.replaceWith(match.from, match.to, [node, schema.text(' ')]));
      view.focus();
    },
    format: (kind: 'strong' | 'em' | 'strike' | 'code') => { toggleMark(schema.marks[kind])(view.state, view.dispatch, view); view.focus(); },
    setEditable: (allowed: boolean) => { editable = allowed; view.setProps({ editable: () => editable }); },
    setLabel: (label: string) => view.dom.setAttribute('aria-label', label),
    destroy: () => view.destroy(),
  };
}

declare global {
  interface Window { AwaitRichEditor: typeof createRichEditor }
}
window.AwaitRichEditor = createRichEditor;
