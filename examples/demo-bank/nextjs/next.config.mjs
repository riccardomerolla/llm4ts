/**
 * Client-only SPA: static export, served from object storage behind a CDN.
 * Mirrors flows/fixtures/scaffolds/nextjs-spa (the bank-provided scaffold).
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'export',
};

export default nextConfig;
