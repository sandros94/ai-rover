import { defineConfig } from 'vitest/config'
import { defineVitestProject } from '@nuxt/test-utils/config'

const rootDir = import.meta.dirname

/** One random session key for the whole run: a built server refuses to start without one. */
const sessionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')

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
          env: { NUXT_SESSION_KEY: sessionKey },
        },
      },
    ],
  },
})
