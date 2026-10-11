/** @type {import('postcss-load-config').Config} */
// Tailwind CSS v4: one PostCSS plugin, which also handles vendor prefixing.
// Theme, plugins and content detection live in app/globals.css now; there is
// no tailwind.config.ts.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
