import { z } from 'zod';
import { wakesFor, type EventOccurrence } from './mcp-events';

export const agentEventSettings = z.object({
  level: z.enum(['off', 'mentions', 'messages', 'activity']),
  include_agent_authors: z.boolean(),
}).strict();
export type AgentEventSettings = z.infer<typeof agentEventSettings>;

export function matchesAgentLevel(settings: AgentEventSettings, accountId: string, event: EventOccurrence): boolean {
  if (settings.level === 'off' || !wakesFor(event, accountId, settings.include_agent_authors)) return false;
  // A mention also has a created/updated occurrence. Emit only one local wake.
  if (event.name === 'message.mentioned') return false;
  if (settings.level === 'mentions') return event.name.startsWith('message.') && Boolean(event.mentions?.includes(accountId));
  if (settings.level === 'messages') return event.name.startsWith('message.');
  return true;
}
