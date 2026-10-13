import type { Env } from './env';

export type GifResult = {
  id: string;
  title: string;
  preview: string;
  url: string;
  page_url: string;
  creator: string;
};

const isGiphyMedia = (value: string) => /^https:\/\/(?:media\d*|i)\.giphy\.com\//i.test(value);

export async function searchGifs(env: Env, phrase: string): Promise<GifResult[]> {
  if (!env.GIPHY_API_KEY) throw new Error('GIPHY search is not configured.');
  const query = phrase.trim().slice(0, 50);
  if (query.length === 1) return [];
  const url = new URL(`https://api.giphy.com/v1/gifs/${query ? 'search' : 'trending'}`);
  url.searchParams.set('api_key', env.GIPHY_API_KEY);
  url.searchParams.set('limit', '16');
  url.searchParams.set('rating', 'pg');
  if (query) url.searchParams.set('q', query);
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.status === 429 ? 'GIF search is busy. Try again shortly.' : 'GIF search is temporarily unavailable.');
  const data = await response.json<{ data?: Array<{ id: string; title?: string; url?: string; username?: string; user?: { display_name?: string }; images?: { fixed_width_small?: { url: string }; fixed_width?: { url: string }; original?: { url: string } } }> }>();
  return (data.data ?? []).flatMap((gif) => {
    const original = gif.images?.original?.url ?? gif.images?.fixed_width?.url ?? '';
    const preview = gif.images?.fixed_width_small?.url ?? gif.images?.fixed_width?.url ?? '';
    if (!isGiphyMedia(original) || !isGiphyMedia(preview)) return [];
    return [{ id: gif.id, title: gif.title || 'GIF', url: original, preview,
      page_url: gif.url?.startsWith('https://giphy.com/') ? gif.url : `https://giphy.com/gifs/${encodeURIComponent(gif.id)}`,
      creator: gif.user?.display_name || gif.username || '' }];
  });
}
