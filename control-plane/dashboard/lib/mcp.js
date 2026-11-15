/**
 * lib/mcp.js — MCP servers and the tools a policy allows (ADR-0016,
 * migration 040).
 *
 * An MCP server is a name (what agents reach at <gateway>/mcp/<name>), its
 * address, and optionally one header the gateway adds to every request to
 * it (Authorization: Bearer ..., X-API-Key: ...), stored encrypted. Agents
 * never see that credential: they connect with their own Stratum key.
 *
 * A policy's mcp_tools lists what its teams may call: "server/*" (every tool
 * of that server) or "server/tool". Empty: no server.
 */

import { badRequest } from './route.js'

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/
export const TOOL_RE = /^[a-z0-9][a-z0-9-]{0,49}\/(\*|[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,127})$/
const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
// Headers the gateway sets itself, or that would change what the request is.
const RESERVED = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'cookie'])

/** A server as an administrator sends it; `required`: on creation. */
export function serverFields(body, { create = false } = {}) {
  const out = {}
  if (create || body.name !== undefined) {
    if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) {
      throw badRequest('Nombre: minúsculas, números y guiones, hasta 50; es la dirección /mcp/nombre.')
    }
    out.name = body.name
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > 300) throw badRequest('Descripción inválida.')
    out.description = body.description.trim()
  }
  if (create || body.url !== undefined) {
    let u
    try { u = new URL(body.url) } catch { throw badRequest('URL inválida.') }
    // Gateways reach it from the customer's network: an internal http
    // address is normal. The console never calls it.
    if (!['https:', 'http:'].includes(u.protocol)) throw badRequest('La URL tiene que ser http(s).')
    if (u.username || u.password || u.hash) throw badRequest('La URL no puede llevar credenciales ni fragmento (#…): la credencial va aparte.')
    out.url = body.url.trim()
  }
  if (body.authHeader !== undefined) {
    if (body.authHeader === null || body.authHeader === '') {
      out.authHeader = null
    } else if (typeof body.authHeader !== 'string' || !HEADER_RE.test(body.authHeader) || RESERVED.has(body.authHeader.toLowerCase())) {
      throw badRequest('Encabezado inválido: por ejemplo Authorization o X-API-Key.')
    } else {
      out.authHeader = body.authHeader
    }
  }
  if (body.secret !== undefined) {
    if (body.secret === null || body.secret === '') {
      out.secret = null
    } else if (typeof body.secret !== 'string' || body.secret.length > 4096 || /[\r\n]/.test(body.secret)) {
      throw badRequest('Valor del encabezado inválido.')
    } else {
      out.secret = body.secret.trim()
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled tiene que ser true o false.')
    out.enabled = body.enabled
  }
  return out
}

/** A policy's mcpTools, validated: unique, sorted. */
export function mcpToolsField(v) {
  if (!Array.isArray(v) || v.length > 200 || v.some(t => typeof t !== 'string' || !TOOL_RE.test(t))) {
    throw badRequest('Herramientas MCP: una lista de servidor/* o servidor/herramienta.')
  }
  return [...new Set(v)].sort()
}

/** Whether `tools` ("server/*", "server/tool") let a team call `tool` of `server`. */
export function toolAllowed(tools, server, tool) {
  const set = new Set(tools ?? [])
  return set.has(`${server}/*`) || set.has(`${server}/${tool}`)
}
