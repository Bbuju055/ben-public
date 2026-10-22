import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 30_000,
  reporter: [['line']],
  use: {
    baseURL: process.env.BEN_E2E_URL ?? 'http://127.0.0.1:4923',
    screenshot: 'on',
    video: 'on', // always — the green run's video is the proof
  },
});
