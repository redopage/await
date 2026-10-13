import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/app/messageTags.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { default: messageTags } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const options = { members: [{ account_id: 'person-1', name: 'Andrew' }], channels: [{ id: 'channel-1', name: 'general' }], workspaceId: 'workspace-1' };
const render = (body, opts = options) => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkBreaks, [messageTags, opts]] }, body));

test('rich editor output renders adjacent bold and mention nodes without literal delimiters', () => {
  const html = render('**Inline editor deployment check passed.&#x20;**<@person-1>&#x20;');
  assert.equal(html, '<p><strong>Inline editor deployment check passed. </strong><strong>@Andrew</strong> </p>');
  assert.equal(html.includes('****'), false);
  assert.equal(render('**<@person-1>**').includes('&lt;@'), false);
});

test('mention display names remain text and cannot inject links or markup', () => {
  const html = render('<@person-1>', { ...options, members: [{ account_id: 'person-1', name: '**Admin** [click](https://example.com) <img src=x>' }] });
  assert.ok(html.includes('@**Admin** [click](https://example.com) &lt;img src=x&gt;'));
  assert.equal(html.includes('<a'), false); assert.equal(html.includes('<img'), false);
});

test('tags resolve in ordinary text and channel links, while code and existing links remain intact', () => {
  const html = render('`<@person-1>`\n\n```text\n<#channel-1>\n```\n\n<#channel-1> and [<#channel-1>](https://example.com)');
  assert.ok(html.includes('<code>&lt;@person-1&gt;</code>'));
  assert.ok(html.includes('&lt;#channel-1&gt;'));
  assert.ok(html.includes('<a href="/w/workspace-1/channel-1">#general</a>'));
  assert.ok(html.includes('<a href="https://example.com">#general</a>'));
  assert.equal((html.match(/<a /g) ?? []).length, 2);
});

test('task tags render as card links in their channel and as plain text elsewhere', () => {
  const tasks = [{ id: 'task-1', title: 'Ship launch page', status: 'doing', board_id: 'board-1' }];
  const html = render('Working on <task:task-1> and <task:missing>', { ...options, tasks, channelId: 'channel-1' });
  assert.ok(html.includes('<a href="/w/workspace-1/channel-1?view=tasks&amp;board=board-1&amp;task=task-1" title="Task · doing">Ship launch page</a>'));
  assert.ok(html.includes('a task'));
  assert.equal(html.includes('&lt;task:'), false);
  const noChannel = render('<task:task-1>', { ...options, tasks });
  assert.equal(noChannel.includes('<a'), false);
  assert.ok(noChannel.includes('Ship launch page'));
});

test('composer output renders code spans, typed Markdown, chips, links and line breaks', async () => {
  const editorBundle = await build({ entryPoints: ['src/app/messageRichText.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { messageSchema: s, serializeMessage } = await import(`data:text/javascript;base64,${Buffer.from(editorBundle.outputFiles[0].text).toString('base64')}`);
  const body = serializeMessage(s.nodes.doc.create(null, s.nodes.paragraph.create(null, [
    s.text('run '), s.text('a`b', [s.marks.code.create()]), s.text(' not **bold** for '), s.nodes.mention.create({ id: 'person-1', label: 'Andrew' }),
    s.text(' in '), s.nodes.channel.create({ id: 'channel-1', label: 'general' }), s.text(' on '), s.nodes.task.create({ id: 'task-1', label: 'Ship launch page' }),
    s.text(' at https://example.com/a_b '), s.nodes.hard_break.create(), s.text('next line'),
  ])));
  const tasks = [{ id: 'task-1', title: 'Ship launch page', status: 'doing', board_id: 'board-1' }];
  const html = render(body, { ...options, tasks, channelId: 'channel-1' });
  assert.equal(html, '<p>run <code>a`b</code> not <strong>bold</strong> for <strong>@Andrew</strong> in <a href="/w/workspace-1/channel-1">#general</a> on '
    + '<a href="/w/workspace-1/channel-1?view=tasks&amp;board=board-1&amp;task=task-1" title="Task · doing">Ship launch page</a> at <a href="https://example.com/a_b">https://example.com/a_b</a><br/>\nnext line</p>');
});
