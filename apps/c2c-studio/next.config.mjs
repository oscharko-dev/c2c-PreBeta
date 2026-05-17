/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/favicon.ico',
        destination: '/favicon.svg?v=mirrored-20260517',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
