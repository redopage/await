import { baseKeymap, chainCommands, exitCode, newlineInCode, setBlockType, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice, type MarkType } from 'prosemirror-model';
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { taskStatuses, type Channel, type Member, type TaskStatus } from '../shared/types';
import type { TagKind } from '../shared/tags';
import { messageSchema as schema } from './messageRichText';

// Editing behaviour shared by the composer and the inline message editor, so the same keystrokes
// build the same document, and therefore the same Markdown, in both.

export type Suggestion = { kind: 'mention' | 'channel'; query: string; from: number; to: number };
export type ChannelTask = { id: string; title: string; status: TaskStatus; board_id: string; board_name: string };
// `node` names the chip to insert: '#' suggests both channels and the channel's Kanban cards.
export type SuggestionItem = { id: string; label: string; node: TagKind; detail?: string; avatar?: string | null; kind?: Member['kind']; status?: TaskStatus };

// Text before the cursor in its block, with line breaks as newlines and chips as object replacement characters.
function textBeforeCursor(state: EditorState): string {
  const { $from } = state.selection;
  return $from.parent.textBetween(0, $from.parentOffset, undefined, (node) => node.type === schema.nodes.hard_break ? '\n' : '\ufffc');
}

// "@" or "#" typed at the start of a word, outside code, suggests people, or channels and cards.
export function currentSuggestion(state: EditorState): Suggestion | null {
  const { empty, from, $from } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || schema.marks.code.isInSet(state.storedMarks ?? $from.marks())) return null;
  const match = textBeforeCursor(state).match(/(?:^|\s)([@#])([^\s@#]{0,40})$/);
  return match ? { kind: match[1] === '@' ? 'mention' : 'channel', query: match[2], from: from - match[2].length - 1, to: from } : null;
}

// Types "@" or "#" to open suggestions, with a space first when it would otherwise join the previous word.
export function startSuggestion(state: EditorState, sigil: '@' | '#'): Transaction {
  const before = textBeforeCursor(state);
  return state.tr.insertText(before && !/\s$/.test(before) ? ` ${sigil}` : sigil);
}

export function suggestionItems(suggestion: Suggestion | null, sources: { members: Member[]; channels: Channel[]; tasks: ChannelTask[] }): SuggestionItem[] {
  if (!suggestion) return [];
  const query = suggestion.query.toLocaleLowerCase();
  const matching = (items: SuggestionItem[]) => items.filter((item) => item.label.toLocaleLowerCase().includes(query));
  if (suggestion.kind === 'mention') return matching(sources.members.map((member): SuggestionItem => ({ id: member.account_id, label: member.name, detail: member.kind === 'agent' ? 'Agent' : undefined, avatar: member.avatar_url, kind: member.kind, node: 'mention' }))).slice(0, 8);
  const rooms = matching(sources.channels.filter((channel) => channel.joined && !channel.archived_at && !channel.is_dm).map((channel): SuggestionItem => ({ id: channel.id, label: channel.name, node: 'channel' })));
  const cards = matching(sources.tasks.map((task): SuggestionItem => ({ id: task.id, label: task.title, detail: `${taskStatuses.find((status) => status.id === task.status)?.name ?? task.status} · ${task.board_name}`, node: 'task', status: task.status })));
  // Keep a few cards visible even in channel-heavy workspaces.
  return (cards.length ? [...rooms.slice(0, 5), ...cards] : rooms).slice(0, 8);
}

// Replaces the typed "@query" with the chosen chip and a space for the next word.
export function insertTag(state: EditorState, suggestion: Suggestion, item: SuggestionItem): Transaction {
  return state.tr.replaceWith(suggestion.from, suggestion.to, [schema.nodes[item.node].create({ id: item.id, label: item.label }), schema.text(' ')]);
}

// Backspace and Delete remove a whole chip at once.
const removeTag = (direction: 'before' | 'after'): Command => (state, dispatch) => {
  if (!state.selection.empty) return false;
  const cursor = state.selection.$from;
  const node = direction === 'before' ? cursor.nodeBefore : cursor.nodeAfter;
  if (!node || !['mention', 'channel', 'task'].includes(node.type.name)) return false;
  const from = cursor.pos - (direction === 'before' ? node.nodeSize : 0);
  dispatch?.(state.tr.delete(from, from + node.nodeSize));
  return true;
};

// Markdown typed in either editor formats as it is typed: **bold**, *italic*, ~~struck~~ and `code`. Underscores
// stay as typed, because they cannot be told apart from snake_case until the next character arrives.
// Backspace straight afterwards undoes the conversion and leaves the characters as typed.
function markShortcut(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, [whole, prefix, content], start, end) => {
    // After an unmatched backtick the delimiters belong to a code span still being typed.
    const $start = state.doc.resolve(start);
    if (type !== schema.marks.code && $start.parent.textBetween(0, $start.parentOffset, undefined, '\ufffc').split('`').length % 2 === 0) return null;
    const open = start + prefix.length, size = (whole.length - prefix.length - content.length) / 2;
    return state.tr.delete(open + size + content.length, end).delete(open, open + size)
      .addMark(open, open + content.length, type.create()).removeStoredMark(type);
  }, { inCodeMark: false });
}

// "```" or "```lang" alone on the last line of a paragraph starts a code block when followed by a space, Enter or
// Shift+Enter. `start` is where the fence begins, or the line break before it.
const fence = /(^|\ufffc)```([\w+#.-]*)$/;
function codeBlock(state: EditorState, [, afterBreak, lang]: RegExpMatchArray, start: number, end: number): Transaction | null {
  const $end = state.doc.resolve(end);
  if ($end.parent.type !== schema.nodes.paragraph || end !== $end.end()) return null;
  if (afterBreak && state.doc.nodeAt(start)?.type !== schema.nodes.hard_break) return null;
  const tr = state.tr.delete(start, end);
  if (afterBreak) tr.split(start);
  const inside = afterBreak ? start + 2 : start;
  tr.setBlockType(inside, inside, schema.nodes.code_block, { lang: lang || null });
  if (tr.doc.resolve(inside).parent.type !== schema.nodes.code_block) return null;
  return tr.setSelection(TextSelection.create(tr.doc, inside));
}
const openFence = new InputRule(/(^|\ufffc)```([\w+#.-]*) $/, (state, match, start, end) => codeBlock(state, match, start, end));
export const startCodeBlock: Command = (state, dispatch) => {
  const { empty, $from } = state.selection;
  const match = empty ? $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc').match(fence) : null;
  const tr = match && codeBlock(state, match, $from.pos - match[0].length, $from.pos);
  if (!tr) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
};

// ``` on a new line at the end of a code block closes it and continues below.
const closeFence = new InputRule(/\n```$/, (state, _match, start, end) => {
  const $end = state.doc.resolve(end);
  if (end !== $end.end()) return null;
  const tr = state.tr.delete(start, end);
  const after = tr.mapping.map($end.after());
  tr.insert(after, schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
}, { inCode: 'only' });

const shortcuts = [
  // Delimiters only open after a space or punctuation, so snake_case and 2*3*4 stay as typed.
  markShortcut(/(^|[^\p{L}\p{N}_*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/u, schema.marks.strong),
  markShortcut(/(^|[^\p{L}\p{N}_*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/u, schema.marks.em),
  markShortcut(/(^|[^\p{L}\p{N}_~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/u, schema.marks.strike),
  // Chips cannot sit inside code, so a span that would swallow one stays as typed.
  markShortcut(/(^|[^`\\])`([^`\ufffc]*[^`\s\ufffc][^`\ufffc]*)`$/, schema.marks.code),
  openFence, closeFence,
];

// Shift+Enter starts a new line: inside code as text, after a fence as a code block, elsewhere as a line break.
const lineBreak: Command = chainCommands(newlineInCode, startCodeBlock, (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
  return true;
});

// ArrowDown at the end of a code block that ends the message opens a line below it.
const leaveCode: Command = (state, dispatch) => {
  const { empty, $head } = state.selection;
  if (!empty || !$head.parent.type.spec.code || $head.pos !== $head.end() || $head.after() !== state.doc.content.size) return false;
  return exitCode(state, dispatch);
};

// Backspace at the start of a code block turns it back into a paragraph, its lines into line breaks.
const unwrapCode: Command = (state, dispatch) => {
  const { empty, $from } = state.selection;
  return empty && $from.parent.type.spec.code && !$from.parentOffset ? setBlockType(schema.nodes.paragraph)(state, dispatch) : false;
};

// Text pasted from outside Await keeps its exact characters and line breaks, so pasted Markdown, code and logs
// arrive as written. Await's own clipboard (ProseMirror's data-pm-slice) keeps its chips and formatting.
const pasteText = new Plugin({
  props: {
    handlePaste(view, event) {
      // The composer already took the pasted files.
      if (event.defaultPrevented) return true;
      const data = event.clipboardData, text = data?.getData('text/plain');
      if (!text || view.state.selection.$from.parent.type.spec.code || data!.getData('text/html').includes('data-pm-slice')) return false;
      const content = text.replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [...index ? [schema.nodes.hard_break.create()] : [], ...line ? [schema.text(line)] : []]);
      view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(schema.nodes.paragraph.create(null, content)), 1, 1)).scrollIntoView());
      return true;
    },
  },
});

// Both editors put their own Enter, Tab, arrow and Escape handling ahead of these.
export function messageEditorPlugins(): Plugin[] {
  return [
    inputRules({ rules: shortcuts }),
    pasteText,
    keymap({
      'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-Shift-x': toggleMark(schema.marks.strike),
      'Mod-z': undo, 'Mod-Shift-z': redo, Enter: startCodeBlock, 'Shift-Enter': lineBreak, ArrowDown: leaveCode,
      Backspace: chainCommands(undoInputRule, removeTag('before'), unwrapCode), Delete: removeTag('after'),
    }),
    history(),
    keymap(baseKeymap),
  ];
}
