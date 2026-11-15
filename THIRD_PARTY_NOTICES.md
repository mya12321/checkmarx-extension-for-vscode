# Third-party notices

This extension bundles the following runtime dependencies into `dist/`:

| Package | License | Project |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| `adm-zip` | MIT | https://github.com/cthackers/adm-zip |
| `https-proxy-agent` | MIT | https://github.com/TooTallNate/proxy-agents |
| `minimatch` | ISC | https://github.com/isaacs/minimatch |
| `tar` | ISC | https://github.com/isaacs/node-tar |
| `zod` | MIT | https://github.com/colinhacks/zod |

Transitive dependencies of these packages are bundled by esbuild and retain their
respective licenses. The Checkmarx CLI is not bundled; it is downloaded from
Checkmarx or reused from an installed Checkmarx extension and is governed by
Checkmarx's own license.

Checkmarx and Checkmarx One are trademarks of Checkmarx Ltd. This project is not
affiliated with or endorsed by Checkmarx.