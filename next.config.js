/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  serverExternalPackages: ['@supabase/supabase-js', '@supabase/ssr'],
};

module.exports = nextConfig;
