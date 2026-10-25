const commonGlobals = Object.fromEntries([
  'console', 'URL', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'AbortSignal',
  'window', 'document', 'navigator', 'FileReader', 'Blob', 'File', 'FormData', 'CustomEvent',
  'innerWidth', 'process', 'Buffer', 'structuredClone',
].map(name => [name, 'readonly']));

export default [
  { ignores: ['node_modules/**', 'dist/**', 'data/**'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest', sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: commonGlobals,
    },
    rules: {
      'no-undef': 'error', 'no-unreachable': 'error', 'valid-typeof': 'error',
      'no-dupe-args': 'error', 'no-dupe-keys': 'error', 'no-unexpected-multiline': 'error',
      'constructor-super': 'error', 'no-constant-binary-expression': 'error',
    },
  },
];
