import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'HH Apply Assistant',
        namespace: 'http://tampermonkey.net/',
        version: '4.0.0',
        description: 'HH Apply Assistant — инструмент автоматизации откликов на вакансии hh.ru (HeadHunter)',
        author: 'Timur Geruzov',
        license: 'GPL-3.0-only',
        homepageURL: 'https://github.com/tgeruzov/hh-apply-assistant',
        supportURL: 'https://github.com/tgeruzov/hh-apply-assistant/issues',
        updateURL: 'https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js',
        downloadURL: 'https://raw.githubusercontent.com/tgeruzov/hh-apply-assistant/main/hh-apply-assistant.user.js',
        match: [
          '*://*.hh.ru/search/vacancy*',
          '*://*.hh.ru/vacancy/*',
          '*://*.hh.ru/applicant/vacancy_response*'
        ],
        grant: 'none',
        'run-at': 'document-idle'
      },
      build: {
        fileName: 'hh-apply-assistant.user.js'
      }
    }),
    {
      name: 'sync-root-userscript',
      closeBundle() {
        const distPath = path.resolve(__dirname, 'dist/hh-apply-assistant.user.js');
        const rootPath = path.resolve(__dirname, 'hh-apply-assistant.user.js');
        if (existsSync(distPath)) {
          copyFileSync(distPath, rootPath);
        }
      }
    }
  ],
  build: {
    minify: false
  }
});
