/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['@supabase/supabase-js', '@supabase/ssr'],
};

module.exports = nextConfig;
