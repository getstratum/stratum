// What the sign-in pages say when a sign-in with the organization's
// identity provider comes back refused (?sso=<reason>, app/api/sso/callback).
export const SSO_MESSAGES = {
  expired: 'El ingreso con SSO venció o empezó en otro navegador. Probá de nuevo.',
  provider: 'El proveedor de identidad no completó el ingreso. Probá de nuevo; si sigue, avisale a quien administra Stratum.',
  account: 'Esa cuenta no puede entrar: tiene que ser de tu organización, con el mail verificado y dada de alta en Stratum.',
  no_console: 'Tu cuenta usa las aplicaciones de la organización, no la consola.',
}
