import { useEffect, useState } from 'react';
import type { Channel } from '../shared/types';

export function usePageVisibility() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

// The tab names the open place and workspace, leads with the mention count, and swaps the favicon while anything is unread.
export function useTabStatus(channels: Channel[], place: string) {
  const joined = channels.filter((channel) => channel.joined);
  const unread = joined.some((channel) => channel.unread > 0 || channel.mentions > 0);
  const mentions = joined.reduce((sum, channel) => sum + channel.mentions, 0);
  const title = `${mentions ? `(${mentions}) ` : ''}${place}`;
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('#await-favicon');
    if (!icon) return;
    icon.href = unread ? '/favicon-unread.svg' : '/favicon.svg';
    return () => { icon.href = '/favicon.svg'; };
  }, [unread]);
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}
