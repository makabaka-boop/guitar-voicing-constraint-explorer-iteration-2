import { defineConfig } from 'vite';

export default defineConfig({
  // 离线页面：构建产物使用相对路径，可直接以 file:// 打开 dist/index.html
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
});
