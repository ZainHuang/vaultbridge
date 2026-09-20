import { defineConfig } from 'vitest/config';

// Existing acceptance/state-machine cases exceed 5s on this Windows host.
// Retain every assertion and iteration; allow bounded scheduling headroom.
export default defineConfig({ test: { testTimeout: 30000 } });
