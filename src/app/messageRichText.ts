import { Schema, type Node as ProseNode, type Mark } from 'prosemirror-model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import type { Root } from 'mdast';
import type { Channel, Member, TaskRef } from '../shared/types';
import { tagsIn, tagText, taskAutolinkId, type TagKind } from '../shared/tags';

export const messageSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    blockquote: { content: 'block+', group: 'block', parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
    heading: { attrs: { level: { default: 2 } }, content: 'inline*', group: 'block', parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })), toDOM: (node) => [`h${node.attrs.level}`, 0] },
    code_block: { attrs: { lang: { default: null }, meta: { default: null } }, content: 'text*', marks: '', group: 'block', code: true, parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }], toDOM: () => ['pre', ['code', 0]] },
    bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
    ordered_list: { attrs: { start: { default: 1 } }, content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ol', getAttrs: (element) => ({ start: Number((element as HTMLElement).getAttribute('start')) || 1 }) }], toDOM: (node) => ['ol', { start: node.attrs.start }, 0] },
    list_item: { attrs: { checked: { default: null } }, content: 'paragraph block*', parseDOM: [{ tag: 'li' }], toDOM: (node) => ['li', { 'data-checked': node.attrs.checked }, 0] },
    table: { attrs: { align: { default: [] } }, content: 'table_row+', group: 'block', parseDOM: [{ tag: 'table' }], toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
    table_cell: { content: 'inline*', parseDOM: [{ tag: 'td' }, { tag: 'th' }], toDOM: () => ['td', 0] },
    horizontal_rule: { group: 'block', parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline', selectable: false, linebreakReplacement: true, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    mention: { inline: true, group: 'inline', atom: true, marks: 'strong em strike link', attrs: { id: {}, label: {} }, parseDOM: [{ tag: 'span[data-mention]', getAttrs: (element) => ({ id: (element as HTMLElement).dataset.mention, label: (element as HTMLElement).textContent?.replace(/^@/, '') }) }], toDOM: (node) => ['span', { class: 'composer-chip', 'data-mention': node.attrs.id, contenteditable: 'false' }, `@${node.attrs.label}`] },
    channel: { inline: true, group: 'inline', atom: true, marks: 'strong em strike link', attrs: { id: {}, label: {} }, parseDOM: [{ tag: 'span[data-channel]', getAttrs: (element) => ({ id: (element as HTMLElement).dataset.channel, label: (element as HTMLElement).textContent?.replace(/^#/, '') }) }], toDOM: (node) => ['span', { class: 'composer-chip channel-chip', 'data-channel': node.attrs.id, contenteditable: 'false' }, `#${node.attrs.label}`] },
    task: { inline: true, group: 'inline', atom: true, marks: 'strong em strike link', attrs: { id: {}, label: {} }, parseDOM: [{ tag: 'span[data-task]', getAttrs: (element) => ({ id: (element as HTMLElement).dataset.task, label: (element as HTMLElement).textContent?.replace(/^#/, '') }) }], toDOM: (node) => ['span', { class: 'composer-chip task-chip', 'data-task': node.attrs.id, contenteditable: 'false' }, `#${node.attrs.label}`] },
    image: { inline: true, group: 'inline', atom: true, marks: 'strong em strike link', attrs: { src: {}, alt: { default: '' }, title: { default: null } }, parseDOM: [{ tag: 'img[src]', getAttrs: (element) => ({ src: (element as HTMLImageElement).getAttribute('src'), alt: (element as HTMLImageElement).alt, title: (element as HTMLImageElement).title || null }) }], toDOM: (node) => ['img', { src: safeUrl(node.attrs.src), alt: node.attrs.alt, title: node.attrs.title }] },
    // Preserve unsupported Markdown, including reference definitions and footnotes, during nearby edits.
    raw_block: { group: 'block', atom: true, attrs: { source: {} }, toDOM: (node) => ['pre', { class: 'edit-markdown-source' }, node.attrs.source] },
    raw_inline: { inline: true, group: 'inline', atom: true, marks: 'strong em strike link', attrs: { source: {} }, toDOM: (node) => ['span', { class: 'edit-markdown-source' }, node.attrs.source] },
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
    link: { attrs: { href: {}, title: { default: null } }, inclusive: false, parseDOM: [{ tag: 'a[href]', getAttrs: (element) => ({ href: (element as HTMLAnchorElement).getAttribute('href'), title: (element as HTMLAnchorElement).title || null }) }], toDOM: (mark) => ['a', { href: safeUrl(mark.attrs.href), title: mark.attrs.title }, 0] },
    code: { code: true, excludes: '_', parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  },
});

function safeUrl(value: string) { return /^(?:https?:|mailto:|\/|#)/i.test(value) ? value : undefined; }

type MdNode = {
  type: string; children?: MdNode[]; value?: string; depth?: number; lang?: string | null; meta?: string | null;
  ordered?: boolean; start?: number | null; spread?: boolean; checked?: boolean | null;
  url?: string; alt?: string | null; title?: string | null; align?: (string | null)[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
// Message text is the Markdown someone typed, so the writer leaves it exactly as it is and the parser keeps
// each text run's source, escapes included. A newline is a line break, as messages show it (remark-breaks).
const parser = unified().use(remarkParse).use(remarkGfm);
const writer = unified().use(remarkStringify, { bullet: '-', fences: true, emphasis: '*', strong: '*', handlers: {
  // Only a pipe inside a table cell needs a backslash.
  text: (node, _parent, state) => state.stack.includes('tableCell') ? node.value.replace(/(?<!\\)\|/g, '\\|') : node.value,
  // Table cells and headings are one line long.
  break: (_node, _parent, state) => state.stack.includes('tableCell') || state.stack.includes('headingAtx') ? ' ' : '\n',
} }).use(remarkGfm);

export function parseMessage(body: string, members: Pick<Member, 'account_id' | 'name'>[], channels: Pick<Channel, 'id' | 'name'>[], tasks: Pick<TaskRef, 'id' | 'title'>[] = []): ProseNode {
  const tree = parser.parse(body) as unknown as MdNode;
  const source = (node: MdNode) => node.position ? body.slice(node.position.start.offset, node.position.end.offset) : node.value ?? '';
  function line(text: string, marks: readonly Mark[]): ProseNode[] {
    const result: ProseNode[] = [];
    let from = 0;
    for (const { kind, id, start, end } of tagsIn(text)) {
      if (start > from) result.push(messageSchema.text(text.slice(from, start), marks));
      const label = kind === 'mention' ? members.find((member) => member.account_id === id)?.name ?? 'Former member'
        : kind === 'channel' ? channels.find((channel) => channel.id === id)?.name ?? 'channel'
          : tasks.find((task) => task.id === id)?.title ?? 'task';
      result.push(messageSchema.nodes[kind].create({ id, label }, null, marks));
      from = end;
    }
    if (from < text.length) result.push(messageSchema.text(text.slice(from), marks));
    return result;
  }
  function convert(node: MdNode, marks: readonly Mark[] = [], inline = false): ProseNode[] {
    const children = (childMarks = marks, childInline = inline) => (node.children ?? []).flatMap((child) => convert(child, childMarks, childInline));
    const create = (name: string, attrs: Record<string, unknown> | null = null, childInline = false) => [messageSchema.nodes[name].create(attrs, children(marks, childInline))];
    switch (node.type) {
      // Later lines start after the quote marker or list indent that continues their block.
      case 'text': return source(node).split('\n').flatMap((text, index) => index
        ? [messageSchema.nodes.hard_break.create(null, null, marks), ...line(text.replace(/^[ \t>]*/, ''), marks)] : line(text, marks));
      case 'paragraph': return create('paragraph', null, true);
      case 'heading': return create('heading', { level: node.depth }, true);
      case 'blockquote': return create('blockquote');
      case 'list': return create(node.ordered ? 'ordered_list' : 'bullet_list', node.ordered ? { start: node.start ?? 1 } : null);
      case 'listItem': return create('list_item', { checked: node.checked ?? null });
      case 'table': return create('table', { align: node.align });
      case 'tableRow': return create('table_row');
      case 'tableCell': return create('table_cell', null, true);
      case 'strong': return children([...marks, messageSchema.marks.strong.create()], true);
      case 'emphasis': return children([...marks, messageSchema.marks.em.create()], true);
      case 'delete': return children([...marks, messageSchema.marks.strike.create()], true);
      case 'link': {
        // <task:id> arrives from Markdown as an autolink; keep it as the task chip.
        const taskId = taskAutolinkId(node);
        if (taskId) return [messageSchema.nodes.task.create({ id: taskId, label: tasks.find((task) => task.id === taskId)?.title ?? 'task' }, null, marks)];
        // A bare URL or email address stays plain text, as it was typed; GitHub-flavoured Markdown links it when it renders.
        const [label] = node.children ?? [];
        if (node.children?.length === 1 && label.type === 'text' && source(label) === source(node)) return convert(label, marks, inline);
        return children([...marks, messageSchema.marks.link.create({ href: node.url, title: node.title ?? null })], true);
      }
      case 'inlineCode': return node.value ? [messageSchema.text(node.value, [messageSchema.marks.code.create()])] : [];
      case 'code': return [messageSchema.nodes.code_block.create({ lang: node.lang ?? null, meta: node.meta ?? null }, node.value ? messageSchema.text(node.value) : undefined)];
      case 'break': return [messageSchema.nodes.hard_break.create(null, null, marks)];
      case 'thematicBreak': return [messageSchema.nodes.horizontal_rule.create()];
      case 'image': return [messageSchema.nodes.image.create({ src: node.url, alt: node.alt ?? '', title: node.title ?? null }, null, marks)];
      default: return [messageSchema.nodes[inline ? 'raw_inline' : 'raw_block'].create({ source: body.slice(node.position?.start.offset, node.position?.end.offset) })];
    }
  }
  const blocks = (tree.children ?? []).flatMap((node) => convert(node));
  return messageSchema.nodes.doc.create(null, blocks.length ? blocks : messageSchema.nodes.paragraph.create());
}

// Blank lines at the start or end of a block are left out; every other line is written as it was typed.
function lineContent(block: ProseNode): ProseNode[] {
  const lines: ProseNode[][] = [[]];
  block.forEach((node) => { if (node.type === messageSchema.nodes.hard_break) lines.push([]); lines[lines.length - 1].push(node); });
  const blank = (line: ProseNode[]) => line.every((node) => node.type === messageSchema.nodes.hard_break || (node.isText && !node.text!.trim()));
  while (lines.length && blank(lines[0])) lines.shift();
  while (lines.length && blank(lines[lines.length - 1])) lines.pop();
  if (lines[0]?.[0]?.type === messageSchema.nodes.hard_break) lines[0].shift();
  return lines.flat();
}

function leaf(node: ProseNode): MdNode {
  switch (node.type.name) {
    case 'hard_break': return { type: 'break' };
    case 'mention': case 'channel': case 'task': return { type: 'html', value: tagText(node.type.name as TagKind, node.attrs.id) };
    case 'image': return { type: 'image', url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title };
    case 'raw_inline': return { type: 'html', value: node.attrs.source };
    default: return messageSchema.marks.code.isInSet(node.marks) ? { type: 'inlineCode', value: node.text ?? '' } : { type: 'text', value: node.text ?? '' };
  }
}

// Spaces at the edge of a mark move outside its delimiters, where Markdown can read them: "**bold** text", not "**bold&#x20;**text".
function wrap(mark: Mark, children: MdNode[]): MdNode[] {
  const before: MdNode[] = [], after: MdNode[] = [];
  while (children[0]?.type === 'text') {
    const value = children[0].value ?? '', text = value.trimStart();
    if (text !== value) before.push({ type: 'text', value: value.slice(0, value.length - text.length) });
    if (text) { children[0] = { type: 'text', value: text }; break; }
    children.shift();
  }
  while (children[children.length - 1]?.type === 'text') {
    const value = children[children.length - 1].value ?? '', text = value.trimEnd();
    if (text !== value) after.unshift({ type: 'text', value: value.slice(text.length) });
    if (text) { children[children.length - 1] = { type: 'text', value: text }; break; }
    children.pop();
  }
  if (!children.length) return [...before, ...after];
  const node: MdNode = mark.type.name === 'link' ? { type: 'link', url: mark.attrs.href, title: mark.attrs.title, children }
    : { type: mark.type.name === 'strong' ? 'strong' : mark.type.name === 'em' ? 'emphasis' : 'delete', children };
  return [...before, node, ...after];
}

// Neighbours that share a mark share its delimiters, so an italic word inside bold text reads **a *b* c**.
// The mark that runs furthest is opened first.
function phrasing(nodes: ProseNode[]): MdNode[] {
  const result: MdNode[] = [];
  for (let index = 0; index < nodes.length;) {
    const marks = nodes[index].marks.filter((mark) => mark.type !== messageSchema.marks.code);
    if (!marks.length) { result.push(leaf(nodes[index++])); continue; }
    let outer = marks[0], end = index + 1;
    for (const mark of marks) {
      let to = index + 1;
      while (to < nodes.length && mark.isInSet(nodes[to].marks)) to++;
      if (to > end) { outer = mark; end = to; }
    }
    result.push(...wrap(outer, phrasing(nodes.slice(index, end).map((node) => node.mark(outer.removeFromSet(node.marks))))));
    index = end;
  }
  return result;
}

export function serializeMessage(doc: ProseNode): string {
  function children(node: ProseNode): MdNode[] { const result: MdNode[] = []; node.forEach((child) => result.push(convert(child))); return result; }
  function convert(node: ProseNode): MdNode {
    const content = () => children(node);
    switch (node.type.name) {
      case 'paragraph': return { type: 'paragraph', children: phrasing(lineContent(node)) };
      case 'heading': return { type: 'heading', depth: node.attrs.level, children: phrasing(lineContent(node)) };
      case 'blockquote': return { type: 'blockquote', children: content() };
      case 'bullet_list': case 'ordered_list': return { type: 'list', ordered: node.type.name === 'ordered_list', start: node.attrs.start ?? null, spread: false, children: content() };
      case 'list_item': return { type: 'listItem', checked: node.attrs.checked, spread: false, children: content() };
      case 'table': return { type: 'table', align: node.attrs.align, children: content() };
      case 'table_row': return { type: 'tableRow', children: content() };
      case 'table_cell': return { type: 'tableCell', children: phrasing(lineContent(node)) };
      case 'code_block': return { type: 'code', lang: node.attrs.lang, meta: node.attrs.meta, value: node.textContent };
      case 'horizontal_rule': return { type: 'thematicBreak' };
      default: return { type: 'html', value: node.attrs.source };
    }
  }
  // An empty paragraph or code block adds nothing to a message, so neither is written.
  const root = { type: 'root', children: children(doc).filter((node) => node.type === 'paragraph' ? node.children?.length : node.type !== 'code' || node.value?.trim()) } as Root;
  return writer.stringify(root).trimEnd();
}
