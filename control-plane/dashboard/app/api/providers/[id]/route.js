export const dynamic = 'force-dynamic'
import { route } from '../../../../lib/route.js'
import { LEGACY_PROVIDERS_GONE } from '../../../../lib/providers-legacy.js'

// See ../route.js: the legacy providers table is read-only.
export const PATCH  = route('providers.manage', async () => LEGACY_PROVIDERS_GONE())
export const DELETE = route('providers.manage', async () => LEGACY_PROVIDERS_GONE())
