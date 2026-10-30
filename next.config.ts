import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

initOpenNextCloudflareForDev();

// Applied to every response. A full Content-Security-Policy is deliberately not set here: Next.js injects inline
// scripts, so a correct CSP needs per-request nonces and should be added and tested separately.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Nobody may embed the app in another site (clickjacking on payment actions).
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Dev only: let phones on the same Wi-Fi open the dev server (e.g. http://192.168.x.x:3000).
  allowedDevOrigins: ['10.229.104.98', '192.168.*.*', '10.*.*.*', '172.*.*.*'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
export default nextConfig;
