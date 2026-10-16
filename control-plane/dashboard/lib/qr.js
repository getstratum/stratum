/**
 * lib/qr.js — QR code as an SVG string, generated on the server (no
 * third-party service ever sees the authenticator secret).
 */

import qrcode from 'qrcode-generator'

export function qrSvg(text) {
  const qr = qrcode(0, 'M') // smallest version that fits; medium error correction
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true, title: 'Código QR para la aplicación de autenticación' })
}
