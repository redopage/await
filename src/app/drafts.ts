export type MessageDraft = { channelId: string; threadId?: string; body: string; doc: unknown; updatedAt: number };
const prefix = (workspaceId: string, selfId: string) => `await.draft.${workspaceId}.${selfId}.`;
export function draftKey(workspaceId: string, selfId: string, channelId: string, threadId?: string) { return `${prefix(workspaceId, selfId)}${channelId}.${threadId ?? 'main'}`; }
export function readDraft(key: string): MessageDraft | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); return value && typeof value.body === 'string' && typeof value.channelId === 'string' ? value : null; } catch { return null; }
}
export function saveDraft(key: string, draft: MessageDraft) {
  try { if (draft.body.trim()) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); window.dispatchEvent(new Event('await:drafts')); } catch { /* Editing still works when local storage is unavailable. */ }
}
export function listDrafts(workspaceId: string, selfId: string): MessageDraft[] {
  try { return Object.keys(localStorage).filter((key) => key.startsWith(prefix(workspaceId, selfId))).map(readDraft).filter((item): item is MessageDraft => Boolean(item)).sort((a, b) => b.updatedAt - a.updatedAt); } catch { return []; }
}
