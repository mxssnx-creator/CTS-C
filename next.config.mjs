export default {
  output: 'standalone', poweredByHeader: false, reactStrictMode: true,
  outputFileTracingExcludes: { '/*': ['./.data/**/*', './**/*.sqlite*', './.env*', './integrations/research/output/**/*'] },
  experimental: { cpus: 2 },
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ] }, { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] }] },
}
