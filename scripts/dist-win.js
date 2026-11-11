#!/usr/bin/env node
// Build the Windows NSIS installer for apps/stage-tamagotchi.
//
// This script wraps electron-builder only. It does NOT install dependencies,
// build the workspace packages, run `electron-vite build`, or export the Godot
// stage. Run these steps first, from the repository root:
//
//   pnpm install
//   pnpm run build:packages
//   mkdir -p engines/stage-tamagotchi-godot/out/win
//   SHERPAW_BUNDLE_MODELS=true pnpm -F @proj-airi/stage-tamagotchi run build
//   node scripts/dist-win.js
//
// An empty engines/stage-tamagotchi-godot/out/win directory is valid. The build
// then ships without the Godot sidecar. Put `godot-stage.exe` in that directory
// first if you want the sidecar included.
//
// On Windows this is plain electron-builder, run with the stage-tamagotchi
// package as the project directory. Elsewhere, electron-builder needs Wine for
// one NSIS step (extracting the uninstaller), so run it inside
// electron-builder's own Wine image with podman (or docker) instead of
// installing Wine on the host.
//
// The container engine is taken from AIRI_CONTAINER, then podman, then docker.
//
// Extra arguments go to electron-builder, e.g.
//   node scripts/dist-win.js --arm64
//   node scripts/dist-win.js --x64 --publish=never
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')

const IMAGE = 'docker.io/electronuserland/builder:wine'
const root = path.join(__dirname, '..')
const appDir = path.join(root, 'apps', 'stage-tamagotchi')
const builderCli = path.join(appDir, 'node_modules', 'electron-builder', 'cli.js')
const extraArgs = process.argv.slice(2)
// `--win` is always needed. Without extra arguments, also pin x64.
const builderArgs = extraArgs.length > 0 ? ['--win', ...extraArgs] : ['--win', '--x64']

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(`[dist:win] could not run ${cmd}: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

function findEngine() {
  const candidates = [process.env.AIRI_CONTAINER, 'podman', 'docker']
  for (const engine of candidates) {
    if (engine && spawnSync(engine, ['--version'], { stdio: 'ignore' }).status === 0)
      return engine
  }
  return null
}

// electron-builder reads `build.extends` from package.json relative to the
// project directory, so the TypeScript config resolves when the working
// directory is the stage-tamagotchi package. This matches
// `pnpm -F @proj-airi/stage-tamagotchi exec electron-builder`.
if (process.platform === 'win32') {
  run(process.execPath, [builderCli, ...builderArgs], appDir)
}

const engine = findEngine()
if (!engine) {
  console.error('[dist:win] needs podman or docker to build the Windows installer off Windows')
  process.exit(1)
}

// Share the host's download caches so Electron and NSIS aren't fetched on
// every run.
const cache = path.join(os.homedir(), '.cache')
const electronCache = path.join(cache, 'electron')
const builderCache = path.join(cache, 'electron-builder')
for (const dir of [electronCache, builderCache]) fs.mkdirSync(dir, { recursive: true })

run(engine, [
  'run',
  '--rm',
  // Skip SELinux relabeling of the whole checkout; the container is trusted.
  '--security-opt',
  'label=disable',
  '-v',
  `${root}:/project`,
  '-v',
  `${electronCache}:/root/.cache/electron`,
  '-v',
  `${builderCache}:/root/.cache/electron-builder`,
  '-e',
  'ELECTRON_CACHE=/root/.cache/electron',
  '-e',
  'ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder',
  '-w',
  '/project/apps/stage-tamagotchi',
  IMAGE,
  'node',
  'node_modules/electron-builder/cli.js',
  ...builderArgs,
], root)
