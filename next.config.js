/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint:     { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ['@supabase/supabase-js', '@supabase/ssr'],
};

module.exports = nextConfig;
