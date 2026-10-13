import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { build as buildEmbeddedEditor } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const widgetHtmlPath = fileURLToPath(new URL('./src/worker/workspace-widget.html', import.meta.url));
const widgetEditorPath = fileURLToPath(new URL('./src/worker/widget-editor.ts', import.meta.url));
const widgetModuleId = '\0virtual:await-workspace-widget';

const workspaceWidget: Plugin = {
  name: 'await-workspace-widget',
  resolveId(id: string) { return id === 'virtual:await-workspace-widget' ? widgetModuleId : null; },
  async load(id: string) {
    if (id !== widgetModuleId) return null;
    this.addWatchFile(widgetHtmlPath);
    this.addWatchFile(widgetEditorPath);
    const html = await readFile(widgetHtmlPath, 'utf8');
    const bundle = await buildEmbeddedEditor({
      entryPoints: [widgetEditorPath], bundle: true, write: false,
      platform: 'browser', format: 'iife', target: 'es2022', minify: true,
    });
    const marker = '/* __AWAIT_EDITOR_BUNDLE__ */';
    if (!html.includes(marker)) throw new Error('Workspace widget editor marker is missing.');
    return `export default ${JSON.stringify(html.replace(marker, bundle.outputFiles[0].text))};`;
  },
};

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), workspaceWidget, cloudflare({
    persistState: process.env.AWAIT_DEV_STATE ? { path: process.env.AWAIT_DEV_STATE } : true,
    remoteBindings: command === 'serve' && process.env.AWAIT_LOCAL_ONLY === '1' ? false : undefined,
    // Cloud tasks can develop without remote credentials. Build/deploy keeps every binding.
    config: command === 'serve' && process.env.AWAIT_LOCAL_ONLY === '1'
      ? (config) => {
        // Returning empty arrays merges with the originals, so clear the resolved config.
        config.artifacts = [];
        config.services = [];
        // Credential-free mode: local dev login is on and any local account can create a workspace.
        config.vars = { ...config.vars, AUTH_EMAIL_ENABLED: '0', EMAIL_ENABLED: '0', DEV_AUTH: '1' };
      }
      : undefined,
  })],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development'),
  },
}));
