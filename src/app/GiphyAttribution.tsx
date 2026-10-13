import { useTheme } from './ThemeProvider';

export default function GiphyAttribution({ className }: { className?: string }) {
  const { resolvedMode } = useTheme();
  return <img className={className} src={resolvedMode === 'dark' ? '/giphy-attribution-light.png' : '/giphy-attribution.png'} alt="Powered by GIPHY" />;
}
