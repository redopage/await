import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { useTheme } from './ThemeProvider';

export default function EmojiCatalog({ onSelect }: { onSelect: (emoji: string) => void }) {
  const { resolvedMode } = useTheme();
  return <Picker
    data={data}
    onEmojiSelect={(emoji: { native: string }) => onSelect(emoji.native)}
    theme={resolvedMode}
    dynamicWidth
    emojiSize={24}
    emojiButtonSize={36}
    maxFrequentRows={2}
    previewPosition="none"
    skinTonePosition="search"
  />;
}
