/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace types package as part of the app build.
  transpilePackages: ['@dpdp/shared'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
    // Customer installation package phase: opt-in first-run activation gate,
    // baked in only for the installer's own frontend image build — unset/
    // false for the existing dev build, so nothing changes there.
    NEXT_PUBLIC_REQUIRE_ACTIVATION: process.env.NEXT_PUBLIC_REQUIRE_ACTIVATION ?? 'false',
  },
};

export default nextConfig;
