// Lets `node --test` import the app's route modules the way Next.js resolves
// them: the '@/' alias (jsconfig.json) and 'next/server', which has no
// "exports" map for Node's ESM resolver.
import { register } from 'node:module'

register('./alias-loader.mjs', import.meta.url)
