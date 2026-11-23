/**
 * lib/http-error.js — an error a console route answers with its own status
 * and code. Apart from lib/route.js so code that also runs outside Next.js
 * (scripts/stratum-admin.mjs) can throw it.
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}
