import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = !watch;

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'none',
  external: ['vscode'],
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development')
  }
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js'
  },
  {
    ...common,
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'dist/mcp-server.js'
  }
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[esbuild] watching extension and MCP server');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log('[esbuild] build complete');
}