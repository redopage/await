import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
// One bundle, so the editing helpers and the tests share a single schema.
const bundle = await build({ stdin: { contents: "export * from './src/app/messageRichText'; export * from './src/app/messageEditing'; export { EditorState, TextSelection } from 'prosemirror-state';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseMessage, serializeMessage, messageSchema, messageEditorPlugins, currentSuggestion, startCodeBlock, startSuggestion, suggestionItems, insertTag, EditorState, TextSelection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const members = [{ account_id: 'person-1', name: 'Andrew' }];
const channels = [{ id: 'channel-1', name: 'general' }];
const tasks = [{ id: 'task-1', title: 'Ship launch page' }];
const parse = (body) => parseMessage(body, members, channels, tasks);

test('mentions and channels become atomic named chips and retain stored IDs', () => {
  const doc = parse('Before <@person-1> and <#channel-1> after.');
  const tags = [];
  doc.descendants((node) => { if (['mention', 'channel'].includes(node.type.name)) tags.push(node); });
  assert.deepEqual(tags.map((node) => node.attrs.label), ['Andrew', 'general']);
  assert.ok(tags.every((node) => node.isAtom && node.nodeSize === 1));
  const body = serializeMessage(doc);
  assert.equal(body, 'Before <@person-1> and <#channel-1> after.');
  assert.ok(parse(body).eq(doc));
});

for (const [name, source] of Object.entries({
  formatting: '**bold** *italic* ~~strike~~ `literal <@person-1>` **bold *nested***',
  links: '[**a link**](https://example.com/a "Title") and <@person-1>\nnext line',
  blocks: '# Title\n\n> Quoted **text**\n\n- one\n- two\n\n3. three\n4. four\n\n---\n\n```js\nconst a = `<@person-1>`;\n```',
  tasks: '- [x] finished\n- [ ] next',
  table: '| Name | Status |\n| :--- | ---: |\n| <@person-1> \\| lead | **Ready** |',
  image: '![GIF](https://media.giphy.com/media/example/giphy.gif)\n\n[GIF on GIPHY](https://giphy.com/gifs/example)',
  references: '[a reference][ref]\n\n[ref]: https://example.com "Title"',
  footnotes: 'Something[^one]\n\n[^one]: Footnote text',
})) test(`${name} survives a rich text round trip`, () => {
  const doc = parse(source);
  const result = serializeMessage(doc);
  assert.ok(parse(result).eq(doc), `${source}\nSerialized as:\n${result}`);
});

test('formatting changed within bold text preserves neighboring marks', () => {
  const doc = messageSchema.nodes.doc.create(null, messageSchema.nodes.paragraph.create(null, [
    messageSchema.text('first ', [messageSchema.marks.strong.create()]),
    messageSchema.text('second', [messageSchema.marks.strong.create(), messageSchema.marks.em.create()]),
    messageSchema.text(' third', [messageSchema.marks.strong.create()]),
  ]));
  assert.ok(parse(serializeMessage(doc)).eq(doc), serializeMessage(doc));
});


test('inline code formatting cannot consume a mention or image', () => {
  const doc = parse('Before <@person-1> ![image](https://example.com/image.png) after.');
  const nodes = [];
  doc.descendants((node) => { if (['mention', 'image'].includes(node.type.name)) nodes.push(node); });
  for (const node of nodes) assert.equal(node.type.allowsMarkType(messageSchema.marks.code), false);
  assert.ok(serializeMessage(doc).includes('<@person-1>'));
  assert.ok(serializeMessage(doc).includes('![image](https://example.com/image.png)'));
});

// Documents built the way the composer builds them: typed text, toolbar marks and inserted chips.
const s = messageSchema;
const paragraph = (...content) => s.nodes.paragraph.create(null, content);
const doc = (...blocks) => s.nodes.doc.create(null, blocks.map((block) => Array.isArray(block) ? paragraph(...block) : block));
const text = (value, ...marks) => s.text(value, marks.map((mark) => typeof mark === 'string' ? s.marks[mark].create() : mark));
const chip = (kind, id, label, ...marks) => s.nodes[kind].create({ id, label }, null, marks.map((mark) => s.marks[mark].create()));
const lineBreak = () => s.nodes.hard_break.create();

test('code spans containing backticks round trip without backslash escapes', () => {
  for (const [code, written] of [['a`b', '``a`b``'], ['`start', '`` `start ``'], ['end`', '`` end` ``'], ['two `` ticks', '`two `` ticks`']]) {
    const source = doc([text('run '), text(code, 'code'), text(' now')]);
    const body = serializeMessage(source);
    assert.equal(body, `run ${written} now`);
    assert.ok(parse(body).eq(source), body);
  }
});

test('Markdown typed or pasted as text is kept as written', () => {
  const typed = doc([text('**x** and *y* and _z_ and ~~w~~ and `v`')]);
  assert.equal(serializeMessage(typed), '**x** and *y* and _z_ and ~~w~~ and `v`');
  const pasted = doc([text('Plan:'), lineBreak(), text('- one'), lineBreak(), text('  - nested'), lineBreak(), text('> see [docs](https://example.com/docs) \\*literal\\* &amp; snake_case')]);
  const body = serializeMessage(pasted);
  assert.equal(body, 'Plan:\n- one\n  - nested\n> see [docs](https://example.com/docs) \\*literal\\* &amp; snake_case');
  // The inline editor shows that as a list and a quote, and saves the same Markdown back, escapes included.
  const edited = serializeMessage(parse(body));
  assert.equal(edited, 'Plan:\n\n- one\n  - nested\n\n> see [docs](https://example.com/docs) \\*literal\\* &amp; snake_case');
  assert.equal(serializeMessage(parse(edited)), edited);
});

test('emphasis marks share their delimiters', () => {
  const marked = doc([text('first ', 'strong'), text('second', 'strong', 'em'), text(' third', 'strong'), text(' and '), text('gone', 'strike')]);
  assert.equal(serializeMessage(marked), '**first *second* third** and ~~gone~~');
  assert.ok(parse(serializeMessage(marked)).eq(marked));
});

test('mention, channel and task chips round trip with their stored IDs and labels', () => {
  const source = doc([text('Ask '), chip('mention', 'person-1', 'Andrew'), text(' in '), chip('channel', 'channel-1', 'general'), text(' about '), chip('task', 'task-1', 'Ship launch page'), text(' '), text('soon ', 'strong'), chip('mention', 'person-1', 'Andrew', 'strong'), text(' ')]);
  const body = serializeMessage(source);
  assert.equal(body, 'Ask <@person-1> in <#channel-1> about <task:task-1> **soon <@person-1>**');
  const chips = [];
  parse(body).descendants((node) => { if (['mention', 'channel', 'task'].includes(node.type.name)) chips.push([node.type.name, node.attrs.id, node.attrs.label]); });
  assert.deepEqual(chips, [['mention', 'person-1', 'Andrew'], ['channel', 'channel-1', 'general'], ['task', 'task-1', 'Ship launch page'], ['mention', 'person-1', 'Andrew']]);
});

test('spaces move outside mark delimiters, and only blank lines at the edges of a block are dropped', () => {
  assert.equal(serializeMessage(doc([text('hello ', 'strong'), text('world')])), '**hello** world');
  assert.equal(serializeMessage(doc([text('Done. ', 'strong'), chip('mention', 'person-1', 'Andrew'), text(' ')])), '**Done.** <@person-1>');
  assert.equal(serializeMessage(doc([lineBreak(), text('  '), lineBreak(), text('  indented'), lineBreak(), lineBreak(), text('next'), lineBreak(), text(' ')])), '  indented\n\nnext');
  assert.equal(serializeMessage(doc([text('a')], [], [text('b')])), 'a\n\nb');
  assert.equal(serializeMessage(doc([text('Title', 'strong'), lineBreak(), text('body')], s.nodes.code_block.create(null, text('  ')))), '**Title**\nbody');
  assert.equal(serializeMessage(doc(s.nodes.code_block.create())), '');
});

test('URLs and email addresses stay as typed, and the inline editor keeps each link form', () => {
  const typed = 'see https://example.com/a_b?x=1_2, http://localhost:3000/w/abc, www.example.com and a_b@example.com';
  assert.equal(serializeMessage(doc([text(typed)])), typed);
  const links = [];
  parse(typed).descendants((node) => { if (node.marks.some((mark) => mark.type.name === 'link')) links.push(node.text); });
  assert.deepEqual(links, []);
  for (const body of [typed, 'open <http://localhost:3000> or [the docs](https://example.com/docs)']) assert.equal(serializeMessage(parse(body)), body);
});

test('a message written in the composer is saved back unchanged by the inline editor', () => {
  const credit = s.marks.link.create({ href: 'https://giphy.com/gifs/example' });
  for (const source of [
    doc([text('Use **x** and `y` literally')]),
    doc([text('run '), text('a`b', 'code'), text(' with '), text('bold ', 'strong'), text('and '), text('both', 'strong', 'em')]),
    doc([chip('mention', 'person-1', 'Andrew'), text(' see '), chip('channel', 'channel-1', 'general'), text(' and '), chip('task', 'task-1', 'Ship launch page'), text(' ')]),
    doc([text('line one'), lineBreak(), text('line two https://example.com/a_b')]),
    doc([s.nodes.image.create({ src: 'https://media.giphy.com/media/example/giphy.gif', alt: 'GIF' })], [text('GIF by Someone on GIPHY', credit)], []),
    doc([text('intro')], s.nodes.code_block.create(null, text('const a = `<@person-1>`;\n\nreturn a;'))),
  ]) {
    const body = serializeMessage(source);
    assert.equal(serializeMessage(parse(body)), body);
  }
});

// Types through the shared input rules, one character at a time, and presses keys through the shared keymaps.
function editor(source = doc([])) {
  const view = { composing: false, state: EditorState.create({ schema: s, doc: source, plugins: messageEditorPlugins() }) };
  view.dispatch = (tr) => { view.state = view.state.apply(tr); };
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  const rules = view.state.plugins.find((plugin) => plugin.spec.isInputRules);
  view.type = (value) => {
    for (const char of value) {
      const { from, to } = view.state.selection;
      if (!rules.props.handleTextInput(view, from, to, char)) view.dispatch(view.state.tr.insertText(char, from, to));
    }
    return view;
  };
  view.press = (key, shiftKey = false) => {
    const event = { key, shiftKey, altKey: false, ctrlKey: false, metaKey: false, keyCode: { Enter: 13, Backspace: 8 }[key] ?? 0 };
    assert.ok(view.state.plugins.some((plugin) => plugin.props.handleKeyDown?.(view, event)), `${key} did nothing`);
    return view;
  };
  view.markdown = () => serializeMessage(view.state.doc);
  view.runs = () => { const runs = []; view.state.doc.descendants((node) => { if (node.isText) runs.push([node.text, node.marks.map((mark) => mark.type.name).join()]); }); return runs; };
  return view;
}

test('Markdown typed in either editor formats the same way', () => {
  const view = editor().type('say **hi**, *em*, ~~old~~ and `npm start`');
  assert.equal(view.markdown(), 'say **hi**, *em*, ~~old~~ and `npm start`');
  assert.deepEqual(view.runs().filter(([, marks]) => marks), [['hi', 'strong'], ['em', 'em'], ['old', 'strike'], ['npm start', 'code']]);
  const literal = 'keep snake_case_name, _private_var, __init__, 2*3*4, café_x_ and a`b';
  assert.deepEqual(editor().type(literal).runs(), [[literal, '']]);
  assert.equal(editor().type('`a **b**`').markdown(), '`a **b**`');
  const edited = editor(parse('**Earlier** text')).type(' and **more**');
  assert.equal(edited.markdown(), '**Earlier** text and **more**');
});

test('``` and a space, Enter or Shift+Enter start a code block, and ``` on a new line at its end closes it', () => {
  const view = editor().type('Here:');
  view.dispatch(view.state.tr.replaceSelectionWith(lineBreak()));
  view.type('``` const a = 1;').press('Enter').type('```done');
  assert.equal(view.markdown(), 'Here:\n\n```\nconst a = 1;\n```\n\ndone');
  assert.equal(editor().type('```js').press('Enter').type('x').markdown(), '```js\nx\n```');
  assert.equal(editor().type('```').press('Enter', true).type('y').markdown(), '```\ny\n```');
  assert.equal(startCodeBlock(editor().type('not a ```').state), false);
  assert.equal(editor().type('not a ``` fence').markdown(), 'not a ``` fence');
});

test('Backspace at the start of a code block turns its lines back into line breaks', () => {
  const view = editor(doc(s.nodes.code_block.create(null, text('a\nb'))));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
  assert.equal(view.press('Backspace').markdown(), 'a\nb');
  assert.equal(view.state.doc.firstChild.type.name, 'paragraph');
});

test('text pasted from outside Await keeps its characters and line breaks', () => {
  const view = editor(doc([text('Logs: ')]));
  const paste = (data, defaultPrevented = false) => view.state.plugins.some((plugin) => plugin.props.handlePaste?.(view, { defaultPrevented, clipboardData: { getData: (type) => data[type] ?? '' } }));
  assert.ok(paste({ 'text/plain': '- one\r\n- two\n\n    indented', 'text/html': '<ul><li>one</li><li>two</li></ul>' }));
  assert.equal(view.markdown(), 'Logs: - one\n- two\n\n    indented');
  // Await's own clipboard and pasted files are left to ProseMirror and the composer.
  assert.equal(paste({ 'text/plain': 'x', 'text/html': '<p data-pm-slice="1 1 []">x</p>' }), false);
  assert.ok(paste({ 'text/plain': 'photo.png' }, true));
  assert.equal(view.markdown(), 'Logs: - one\n- two\n\n    indented');
});

test('suggestions open after @ or # at the start of a word, outside code', () => {
  const at = (view) => currentSuggestion(view.state);
  assert.deepEqual(at(editor().type('Hi @an')), { kind: 'mention', query: 'an', from: 4, to: 7 });
  assert.equal(at(editor().type('#gen')).kind, 'channel');
  assert.equal(at(editor().type('mail me@an')), null);
  assert.equal(at(editor().type('`@an')), null);
  const afterBreak = editor().type('first');
  afterBreak.dispatch(afterBreak.state.tr.replaceSelectionWith(lineBreak()));
  assert.equal(at(afterBreak.type('@')).query, '');
  const typed = editor().type('word');
  typed.dispatch(startSuggestion(typed.state, '@'));
  assert.equal(typed.state.doc.textContent, 'word @');
});

test('suggestions keep cards visible beside many channels and insert chips', () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ id: `room-${index}`, name: `launch-${index}`, joined: true, archived_at: null, is_dm: 0 }));
  const cards = [{ id: 'task-1', title: 'Launch page', status: 'doing', board_id: 'board-1', board_name: 'Plan' }];
  const items = suggestionItems({ kind: 'channel', query: 'launch', from: 0, to: 0 }, { members: [], channels: many, tasks: cards });
  assert.deepEqual(items.map((item) => item.node), ['channel', 'channel', 'channel', 'channel', 'channel', 'task']);
  assert.equal(items[5].detail, 'In progress · Plan');
  const view = editor().type('ping @An');
  view.dispatch(insertTag(view.state, currentSuggestion(view.state), suggestionItems(currentSuggestion(view.state), { members: [{ account_id: 'person-1', name: 'Andrew', kind: 'human' }], channels: [], tasks: [] })[0]));
  assert.equal(view.type('now').markdown(), 'ping <@person-1> now');
});
