import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The applier's own naming rule: `<digits>_<slug>/migration.sql` or `<digits>_<slug>.sql`.
const NAME = /^\d+_.+$/

/** Migration names in `directory`, sorted the way the applier runs them. */
export async function listMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && NAME.test(entry.name)) names.push(entry.name)
    else if (entry.isFile() && entry.name.endsWith('.sql')) {
      const name = entry.name.slice(0, -'.sql'.length)
      if (NAME.test(name)) names.push(name)
    }
  }
  return names.toSorted((a, b) => a.localeCompare(b))
}

/** sha256 of migration `name` as it reads now, or null when neither of its files exists. */
export async function migrationDigest(directory: string, name: string): Promise<string | null> {
  for (const path of [join(directory, name, 'migration.sql'), join(directory, `${name}.sql`)]) {
    try {
      return createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}
