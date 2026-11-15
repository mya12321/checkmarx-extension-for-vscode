# Checkmarx Local Scan & MCP（VS Code 扩展）

使用 Checkmarx API Key，在 VS Code 中通过官方 `cx` CLI 执行扫描，并注册 MCP Server 让 AI 读取扫描结果、修复代码并复扫验证。

本扩展**不依赖**官方扩展的 Developer Assist / Direct Scan from IDE 权限，也不修改官方扩展的配置。它直接调用 Checkmarx CLI 的公开命令，并自动把结果整理给 VS Code 的 AI Agent。

## 三种扫描模式

1. **整个项目扫描**（手动）
   - `cloud`：`cx scan create` 上传源码到 Checkmarx One，执行 SAST/SCA/IaC/API 等云端扫描。
   - `local`：使用本地 ASCA 引擎逐文件扫描，**不上传代码**。
2. **单文件扫描**（手动）
   - 默认本地 ASCA；只有显式开启 `checkmarxLocal.scan.fileFallbackToCloud` 后，失败时才会回退为只扫描该文件的云端扫描。
3. **当前文件实时扫描**（自动）
   - 保存时扫描，或输入时防抖扫描（`onSave` / `onType`）。
   - 结果合并进 Problems 诊断，修复后复扫会清除旧问题。

## 安装与登录

```bash
npm install
npm run package
code --install-extension checkmarx-local-0.1.3.vsix
```

1. 打开一个文件夹。
2. 运行 **Checkmarx: Sign In with API Key**。
3. 选择区域（US / EU / 自定义），填写 Tenant 和 API Key。
4. API Key 保存在 VS Code SecretStorage，通过 `CX_APIKEY` 环境变量传给 CLI，不会出现在命令行参数或日志中。

如果暂时无法联网验证，可以选择 **Save anyway**；本地 ASCA 扫描不需要 API Key，云端扫描稍后可重试。如果没有保存 Secret，也会兼容已有的 `CX_APIKEY` / `CX_BASE_URI` / `CX_TENANT` 环境变量。

## Activity Bar 控制面板

点击左侧 Activity Bar 的 **Checkmarx** 图标，默认打开 **Dashboard** 视图，常用操作都可以一键完成：

- 内嵌 API Key 登录表单（区域、Base URI、IAM URI、Tenant、API Key）与退出登录。
- 项目扫描：**上传云端** / **本地 ASCA**；云端卡片提供 **Set / Change** 设置关联的 Checkmarx One Application。
- 当前文件：**上传云端** / **本地 ASCA**；没有打开文件时按钮自动禁用。
- 实时扫描开关（按设置使用保存时或输入时触发）。
- 实时进度条与取消按钮。
- 按严重级别统计、最近扫描、打开结果、清空结果。
- CLI 状态与安装/选择路径、MCP 状态与重启。

Results 和 Scans 视图仍保留在同一个 Checkmarx Activity Bar 容器中，位于 Dashboard 下方。

## MCP 与 AI 自动修复

扩展启动后会自动向 VS Code 注册名为 **Checkmarx Local Scan** 的 MCP Server，无需手写 `mcp.json`。

在 Copilot Chat 的 Agent 模式中打开工具选择器，启用 Checkmarx 工具，然后可以输入：

```text
扫描这个项目并修复最严重的安全问题。每修改一个文件后，重新扫描该文件，确认问题消失。
```

MCP 工具包括：

- `checkmarx_get_state`：登录、CLI、最新扫描和数量统计
- `checkmarx_scan_project`：项目扫描，支持 `engine="local"` / `engine="cloud"`（不传时使用扩展设置）
- `checkmarx_scan_file`：单文件扫描；`engine="local"` 为默认值，用于修复后验证；`engine="cloud"` 会在用户确认后上传该文件做云端扫描
- `checkmarx_get_results`：按严重级别/类型/文件筛选结果
- `checkmarx_get_finding`：完整描述、修复建议、数据流和上下文代码
- `checkmarx_get_file_findings`：某个文件的全部问题
- `checkmarx_list_scans`、`checkmarx_get_files`、`checkmarx_cancel_scan`、`checkmarx_open_finding`

MCP 的 instructions 会要求 AI：先读取结果，再修复根因，禁止用忽略/抑制问题的方式通过扫描，修改后必须复扫。

AI 触发的云端扫描会弹出 VS Code 确认框；拒绝后代码不会上传。本地扫描不会上传代码，也不会弹窗。`checkmarx_scan_file` 默认使用本地 ASCA，AI 修复后复扫不会意外上传。

其他 MCP 客户端（Claude Desktop、Cursor 等）可以通过命令 **Checkmarx: Show MCP Server Info** 复制配置。配置中含有本机 loopback bridge token，请勿泄露。

## 主要命令

| 命令 | 说明 |
| --- | --- |
| `Checkmarx: Scan Project` | 按设置选择 cloud/local 扫描整个项目 |
| `Checkmarx: Scan Project (Checkmarx One cloud)` | 强制云端全项目扫描 |
| `Checkmarx: Scan Project (local ASCA engine)` | 强制本地全项目扫描 |
| `Checkmarx: Open Dashboard` | 打开 Activity Bar 控制面板 |
| `Checkmarx: Set Application Name` | 设置云端扫描关联的 Checkmarx One 应用（CODE 225） |
| `Checkmarx: Scan Current File` | 按设置扫描当前文件 |
| `Checkmarx: Scan File...` | 选择文件并按设置扫描 |
| `Checkmarx: Scan Current File (Cloud)` | 强制云端扫描当前文件 |
| `Checkmarx: Scan Current File (Local ASCA)` | 强制本地 ASCA 扫描当前文件 |
| `Checkmarx: Scan File... (Cloud)` | 选择文件并上传云端扫描 |
| `Checkmarx: Scan File... (Local ASCA)` | 选择文件并本地扫描 |
| `Checkmarx: Toggle Real-time Scan` | 开关实时扫描 |
| `Checkmarx: Fix Finding with AI` | 生成修复提示词并打开聊天 |
| `Checkmarx: Export Results...` | 导出 JSON / Markdown / CSV |
| `Checkmarx: Install / Update CLI` | 下载官方 CLI 到扩展存储 |
| `Checkmarx: Show MCP Server Info` | 查看/复制 MCP 配置 |
| `Checkmarx: Run Diagnostics` | 检查 CLI、登录、MCP、实时扫描状态 |

## 关键设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `checkmarxLocal.baseUri` | `""` | Checkmarx One 地址，如 `https://ast.checkmarx.net` |
| `checkmarxLocal.baseAuthUri` | `""` | IAM 地址，如 `https://iam.checkmarx.net` |
| `checkmarxLocal.tenant` | `""` | 租户名 |
| `checkmarxLocal.cliPath` | `auto` | `cx` 路径；auto 会查找 PATH、扩展托管目录、官方扩展内置 CLI |
| `checkmarxLocal.project.applicationName` | `""` | 云端扫描关联的已有 Checkmarx One 应用名（CODE 225 必填） |
| `checkmarxLocal.scan.projectEngine` | `cloud` | 项目扫描引擎 `cloud` / `local` |
| `checkmarxLocal.scan.scanTypes` | `["sast"]` | 云端扫描类型 |
| `checkmarxLocal.scan.fileEngine` | `local` | 单文件扫描引擎 |
| `checkmarxLocal.scan.exclude` | 常见构建目录 | 本地扫描排除规则 |
| `checkmarxLocal.realtime.enabled` | `false` | 实时扫描 |
| `checkmarxLocal.realtime.trigger` | `onSave` | `onSave` / `onType` |
| `checkmarxLocal.mcp.enabled` | `true` | 注册 MCP Server |
| `checkmarxLocal.diagnostics.minSeverity` | `LOW` | Problems 最低显示级别 |

完整设置见 [README.md](README.md)。

## 安全与隐私

- API Key 存在 VS Code SecretStorage，通过环境变量传给 CLI。
- 本地 ASCA 扫描不把源码上传到云端；云端扫描会在执行前弹窗确认（每个会话一次）。
- MCP bridge 只监听 `127.0.0.1`，所有请求需要随机 token，拒绝非本机连接。
- 工作区必须处于 trusted 状态；扩展不适用于 virtual workspace。
- 扫描结果保存在扩展 global storage 中，原始 CLI JSON 不持久化。

## 限制

- 只扫描**第一个 workspace folder**；多根工作区建议分窗口打开。
- 本地项目扫描是 ASCA 逐文件扫描，受 `checkmarxLocal.scan.localMaxFiles`（默认 2000）限制，适合中小项目；需要完整 SCA/IaC 时请使用云端扫描。
- 持久化结果有数量上限，窗口重载前内存中的完整结果仍可用。
- MCP 工具包装本扩展的扫描结果；忽略/状态管理等仍建议在 Checkmarx 官方界面完成。

## 常见问题

### 云端扫描报 `CODE: 225, Missing Associated Application`

租户要求项目和某个 Checkmarx One Application 关联。请在 Dashboard 的 **Project scan** 卡片点击 **Set** / **Change**，填入已有应用名；或设置 `checkmarxLocal.project.applicationName`。名称必须完全匹配，且 API Key 有该应用权限。如果租户还没有应用，请先在 **Checkmarx One → Applications** 创建。

- **找不到 cx**：运行 `Checkmarx: Install / Update CLI`，或设置 `checkmarxLocal.cliPath`。代理环境请设置 `HTTPS_PROXY` / `HTTP_PROXY`。
- **ASCA 引擎安装失败**：CLI 会安装到 `~/.checkmarx/CxVorpal`，需要可写的 home 目录和访问 `download.checkmarx.com`。
- **云端扫描权限错误**：API Key 可能没有扫描权限，或租户未授权对应扫描类型；可改用 `local` 项目扫描。
- **MCP 工具不出现**：确认 `checkmarxLocal.mcp.enabled`，运行 `Checkmarx: Restart MCP Server`，在 Copilot 工具选择器中启用 Checkmarx 工具；远程 SSH 下确保扩展运行在 workspace 侧。

## 许可

MIT。Checkmarx、Checkmarx One 是 Checkmarx Ltd. 的商标。本项目与 Checkmarx 官方无关。请仅使用你有权使用的 Checkmarx 账号和租户；云端扫描类型和本地引擎仍受你的 Checkmarx 订阅及租户配置约束。