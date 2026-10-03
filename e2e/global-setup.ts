// Import test files come from the same generator as the pytest fixtures
// (backend/tests/import_files.py), derived from the Tandemtal sample.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FILES_DIR = fileURLToPath(new URL('./.files/', import.meta.url))

export default function globalSetup() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  execFileSync('uv', ['run', 'python', 'backend/tests/import_files.py', FILES_DIR], {
    cwd: root,
    stdio: 'ignore',
  })
}
