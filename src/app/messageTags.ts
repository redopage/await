import type { Parent, Root, RootContent } from 'mdast';
import { tagsIn, taskAutolinkId } from '../shared/tags';
import type { TaskRef } from '../shared/types';

type Options = {
  members: { account_id: string; name: string }[];
  channels: { id: string; name: string }[];
  tasks?: TaskRef[];
  workspaceId: string;
  channelId?: string;
};

export const taskLinkPattern = /^\/w\/[^/]+\/[^/?]+\?view=tasks&board=[^&]+&task=([^&]+)$/;

// Resolve stored tags after Markdown parsing so adjacent marks and literal
// code remain intact, and display names cannot inject Markdown formatting.
// Mentions become bold text, channels and tasks become links the renderer can style as chips.
export default function messageTags({ members, channels, tasks = [], workspaceId, channelId }: Options) {
  const people = new Map(members.map((member) => [member.account_id, member.name]));
  const rooms = new Map(channels.map((channel) => [channel.id, channel.name]));
  const cards = new Map(tasks.map((task) => [task.id, task]));
  return (tree: Root) => {
    const taskNode = (id: string): RootContent => {
      const card = cards.get(id);
      const label = { type: 'text' as const, value: card ? card.title : 'a task' };
      return card && channelId
        ? { type: 'link', url: `/w/${encodeURIComponent(workspaceId)}/${encodeURIComponent(channelId)}?view=tasks&board=${encodeURIComponent(card.board_id)}&task=${encodeURIComponent(card.id)}`, title: `Task · ${card.status}`, children: [label] }
        : label;
    };
    function walk(parent: Parent, insideLink = false): void {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        // Markdown reads <task:id> as an autolink with a task: scheme; turn it back into a card reference.
        if (node.type === 'link') {
          const taskId = taskAutolinkId(node);
          if (taskId) return [insideLink ? { type: 'text', value: cards.get(taskId)?.title ?? 'a task' } : taskNode(taskId)];
        }
        if ('children' in node) walk(node, insideLink || node.type === 'link');
        if (node.type !== 'text') return [node];
        const parts: RootContent[] = [];
        let cursor = 0;
        for (const { kind, id, start, end } of tagsIn(node.value)) {
          if (start > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, start) });
          if (kind === 'mention') parts.push({ type: 'strong', children: [{ type: 'text', value: `@${people.get(id) ?? 'unknown'}` }] });
          else if (kind === 'channel') {
            const name = rooms.get(id);
            const label = { type: 'text' as const, value: name ? `#${name}` : '#channel' };
            parts.push(name && !insideLink ? { type: 'link', url: `/w/${encodeURIComponent(workspaceId)}/${encodeURIComponent(id)}`, children: [label] } : label);
          } else parts.push(insideLink ? { type: 'text', value: cards.get(id)?.title ?? 'a task' } : taskNode(id));
          cursor = end;
        }
        if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) });
        return parts.length ? parts : [node];
      });
    }
    walk(tree);
  };
}
