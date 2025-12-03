import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            'ts-firebase-simulator': path.resolve(__dirname, './src/index.ts'),
        },
    },
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
