// ESLint 10 flat config. `eslint-config-next` ships flat configs for Next 16;
// `core-web-vitals` is the stricter of its two presets.
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ['out/**', '.next/**', 'next-env.d.ts'],
  },
];

export default config;
