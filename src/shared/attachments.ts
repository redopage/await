import type { Attachment } from './types';

export function attachmentKind(mime: string): Attachment['kind'] {
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(type)) return 'image';
  if (type === 'application/vnd.excalidraw+json') return 'drawing';
  return 'file';
}

// Older MCP uploads stored raster images as files. Normalize reads as well as writes.
export function normalizeAttachment<T extends { mime: string; kind: string }>(attachment: T): T & { kind: Attachment['kind'] } {
  return { ...attachment, kind: attachmentKind(attachment.mime) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
