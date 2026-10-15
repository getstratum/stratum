const root = new URL('../', import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const url = new URL(specifier.slice(2), root).href
    try {
      return await next(url, context)
    } catch {
      return next(`${url}.js`, context)
    }
  }
  if (specifier === 'next/server') return next('next/server.js', context)
  return next(specifier, context)
}
