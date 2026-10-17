import { defineConfig } from 'tsdown'

/**
 * Builds a folder that AIRI can import as an extension.
 *
 * Folder import rejects symbolic links, so the folder holds no `node_modules`.
 * Every dependency is bundled into one `index.mjs`, and only Node built-ins stay external.
 */
export default defineConfig({
  entry: { index: './src/index.ts' },
  outDir: 'dist/extension',
  platform: 'node',
  // NOTICE:
  // xsschema imports the converter of each schema vendor on demand. `effect` and `sury` are not installed.
  // The plugin passes only valibot schemas, so those imports never run.
  // Source: node_modules/xsschema/dist/{effect,sury}-*.js, `tryImport(import('<vendor>'))`.
  // Remove when xsschema stops importing unused vendors.
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
    neverBundle: ['effect', 'sury'],
  },
  copy: [{ from: 'extension.airi.json', to: 'dist/extension' }],
})
