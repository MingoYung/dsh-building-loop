import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = path => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'))
const manifest = readJson('package.json')
const registered = new Set(readJson('INDEX.json').entries.map(entry => entry.path))

function gitFiles(args) {
  // NUL separation preserves spaces and non-ASCII names regardless of Git quoting settings.
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z', ...args], { encoding: 'utf8' })
  return output.split('\0').filter(Boolean)
}

function requiresProjectEntry(path) {
  if (path === 'INDEX.json' || path.startsWith('changes/')) return false
  // The data manifest is the project entry point for archived evidence and its submanifests.
  return !path.startsWith('experiments/data/') || path === 'experiments/data/index.json'
}

const tracked = gitFiles(['--cached'])
const pendingReleaseFiles = gitFiles(['--others', '--exclude-standard', '--', ...manifest.files])
const missing = [...new Set([...tracked, ...pendingReleaseFiles])]
  .filter(path => requiresProjectEntry(path) && !registered.has(path))
  .sort()

if (missing.length) {
  console.error('INDEX.json 漏登了以下项目文件：\n' + missing.join('\n'))
  process.exitCode = 1
} else {
  console.log('INDEX.json 已覆盖 Git 受管文件和待加入的发布文件。')
}
