/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Sign-in pages are never shown inside another site's frame, so a page
  // of that site cannot lay itself over them and catch the clicks.
  async headers() {
    const noFrames = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    ]
    return [
      { source: '/login', headers: noFrames },
      { source: '/oidc/:path*', headers: noFrames },
    ]
  },
}

export default nextConfig
