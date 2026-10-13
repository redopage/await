import type { Image, Link, Parent, Root } from 'mdast';

function isCredit(node: Parent['children'][number]): node is Link {
  return node.type === 'link' && node.url.startsWith('https://giphy.com/') && node.children.every((child) => child.type === 'text')
    && node.children.map((child) => child.type === 'text' ? child.value : '').join('').endsWith('on GIPHY');
}

function moveCredit(image: Image, children: Parent['children'], from: number) {
  let index = from;
  while (children[index]?.type === 'text' && !(children[index] as { value: string }).value.trim()) index++;
  const link = children[index];
  if (!link || !isCredit(link)) return false;
  image.data = { ...image.data, hProperties: { 'data-giphy-page': link.url,
    'data-giphy-credit': link.children.map((child) => child.type === 'text' ? child.value : '').join('') } };
  children.splice(from, index - from + 1);
  return true;
}

// Keep each GIF and its adjacent credit together, including older inline posts.
// Working on Markdown nodes leaves code examples and unrelated links untouched.
export default function giphyCredits() {
  return (tree: Root) => {
    const walk = (parent: Parent) => {
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (!('children' in node)) continue;
        walk(node);
        if (node.type !== 'paragraph') continue;
        for (let childIndex = 0; childIndex < node.children.length; childIndex++) {
          const image = node.children[childIndex];
          if (image.type !== 'image' || !/^https:\/\/(?:media\d*|i)\.giphy\.com\//i.test(image.url)) continue;
          if (moveCredit(image, node.children, childIndex + 1)) continue;
          const next = parent.children[index + 1];
          const isLast = node.children.slice(childIndex + 1).every((child) => child.type === 'text' && !child.value.trim());
          if (isLast && next?.type === 'paragraph' && moveCredit(image, next.children, 0)
            && next.children.every((child) => child.type === 'text' && !child.value.trim())) parent.children.splice(index + 1, 1);
        }
      }
    };
    walk(tree);
  };
}
