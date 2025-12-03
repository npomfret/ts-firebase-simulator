import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        threads: false,
        maxConcurrency: 1,
        testTimeout: 10000,
        hookTimeout: 10000,
        teardownTimeout: 10000,
        setupFiles: ['./vitest.setup.ts'],
        poolOptions: {
            threads: {
                singleThread: true,
            },
        },
        coverage: {
            enabled: false,
        },
    },
});
