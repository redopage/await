// Inline references share one stored form: <@account> for people, <#channel> for channels,
// <task:id> for Kanban cards. Server and clients parse them with this module only.

export type TagKind = 'mention' | 'channel' | 'task';
export type Tag = { kind: TagKind; id: string; start: number; end: number };

export const TAG_PATTERN = /<(@|#|task:)([a-zA-Z0-9_-]+)>/g;

const kinds: Record<string, TagKind> = { '@': 'mention', '#': 'channel', 'task:': 'task' };
const sigils: Record<TagKind, string> = { mention: '@', channel: '#', task: 'task:' };

export function tagsIn(text: string): Tag[] {
  return [...text.matchAll(TAG_PATTERN)].map((match) => ({ kind: kinds[match[1]], id: match[2], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

export function tagIds(text: string, kind: TagKind): string[] {
  return [...new Set(tagsIn(text).filter((tag) => tag.kind === kind).map((tag) => tag.id))];
}

export const mentionIds = (text: string) => tagIds(text, 'mention');
export const taskIds = (text: string) => tagIds(text, 'task');

export function tagText(kind: TagKind, id: string): string {
  return `<${sigils[kind]}${id}>`;
}

// Markdown reads <task:id> as an autolink: a link whose URL and only text are both `task:id`.
export function taskAutolinkId(link: { url?: string | null; children?: { type: string; value?: string }[] }): string | null {
  const id = link.url?.match(/^task:([a-zA-Z0-9_-]+)$/)?.[1];
  const only = link.children?.length === 1 ? link.children[0] : undefined;
  return id && only?.type === 'text' && only.value === link.url ? id : null;
}
