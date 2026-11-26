// Checks catalog/models.json with the parser the control plane applies it
// with (control-plane/dashboard/lib/model-feed.js): a feed that would be
// refused never reaches main. Run by .github/workflows/catalog.yml, in
// seconds, for pull requests that change only the catalog.
//
//   node catalog/check.mjs [path]

import { readFileSync } from 'node:fs'
import { parseFeed } from '../control-plane/dashboard/lib/model-feed.js'

const path = process.argv[2] ?? new URL('./models.json', import.meta.url)
const parsed = parseFeed(JSON.parse(readFileSync(path, 'utf8')))
const retiring = parsed.models.filter(m => m.deprecatedOn).length
console.log(`catalog ${parsed.updated}: ${parsed.models.length} models, ${retiring} with a retirement date`)
