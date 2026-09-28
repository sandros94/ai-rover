import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

const rootDir = import.meta.dirname

const alias = {
  '~': `${rootDir}/app`,
  '~~': rootDir,
  '#shared': `${rootDir}/shared`,
  '#server': `${rootDir}/server`,
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias,
  },

  test: {
    projects: [
      {
        resolve: {
          alias,
        },
        test: {
          name: 'unit',
          /** Database-backed files each start an in-memory Postgres; under a full parallel run one can take seconds. */
          testTimeout: 20_000,
          /** Most of those files start theirs in a `beforeAll`. */
          hookTimeout: 20_000,
          include: ['test/unit/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['test/nuxt/**/*.{test,spec}.ts'],
          environment: 'nuxt',
        },
      }),
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
