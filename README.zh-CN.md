# Marginote 中文入门

[English](README.md)

**把电脑上的文档放进浏览器，选中一段话提问，再决定是否接受 AI 提出的修改。**

Marginote 是在你电脑上运行的文档编辑器，不需要上传文件。文档文件夹在界面里叫
**vault**，可以直接理解为“工作文件夹”。不配置 AI，也能编辑和批注。

第一次用，先完成下面的“启动 → 批注 → AI 回复”三步。连接已有 Codex 等会话是可选的进阶用法。

## 第一步：启动，看到一篇文档

需要 **Node.js 22 或更新版本**，以及随它安装的 npm。打开 macOS 的“终端”、Windows 的
PowerShell 或 Linux 终端，输入 `node --version` 检查版本。下面的命令都在终端输入，不是在浏览器输入。

**0.2.0 正式版**已包含 Markdown、HTML、LaTeX，以及可选的 Codex、Claude Code、Hermes
原会话集成，无需从源码构建。原生会话集成仍属实验性功能，要求见后面的进阶说明。

### 一条命令开始体验

```bash
npx marginote@0.2.0 --demo --open
```

如果提示安装包，确认即可。终端保持打开，浏览器会自动打开；没有自动打开时，访问终端打印的 `local` 地址，通常是：

**http://127.0.0.1:4321/**

看到左侧文件列表后，点击 `welcome.md`，就可以继续第二步。

**这是临时演示：按 `Ctrl+C` 停止后，演示文件、批注和设置会被删除。** 想保存自己的工作，
先停止演示，再运行：

```bash
npx marginote@0.2.0 --open
```

默认文件夹是 `~/Documents/Marginote`。首次创建时会放入欢迎文档。你可以将自己的文档
文件放进去，也可以直接打开已有文件夹：

```bash
npx marginote@0.2.0 "/你的文档文件夹路径" --open
```

把引号里的路径换成真实路径。Windows 可以写成 `"C:\Users\你的用户名\Documents\notes"`。

### 打开自己的文档

想指定文件，例如文件夹中有 `report.md`，用：

```bash
npx marginote@0.2.0 "/你的文档文件夹路径" --doc report.md --open
```

`--doc` 后面是相对于文档文件夹的路径，不是整个绝对路径。也可以换成 `report.html` 或
`main.tex`。LaTeX 的 PDF 预览还需要[额外安装编译器和沙箱](docs/latex-and-images.md)。

经常使用可以先执行 `npm install -g marginote@0.2.0`，之后用 `marginote` 代替
`npx marginote@0.2.0`。运行 `marginote --version` 检查安装版本，或用
`npx marginote@0.2.0 --help` 查看完整选项。

## 第二步：选一段话，发出批注

1. 点击左侧的 `welcome.md`。
2. 在**源码编辑区**拖动选中一句话。源码区隐藏时，先点 **Show the document source**。
3. 点顶部 **Comment**，输入“这句话哪里不清楚？”，再点输入框旁的 **Comment**。
4. 批注会出现在侧边。继续讨论时，点 **Reply**，输入内容，再点 **Send reply**。

没有配置 AI 时，批注只会保存下来，不会自动收到回复。这时你已经可以把它当普通文档编辑器使用。

直接编辑正文会自动保存到原文件。打开 **Suggesting** 后，你自己的修改也会变成待审建议。
建议卡片上的 **Accept** 是“接受并写入”，**Reject** 是“拒绝并保留原文”。

HTML 还可以选中渲染页面里的静态文字，点预览上方的 **Comment selected text** 来批注。

## 第三步：让 AI 回复并提出修改

点顶部 **Settings**，填写：

| 界面字段 | 填什么 |
| --- | --- |
| **Base URL** | 模型服务商提供的 OpenAI 兼容 API 基础地址，通常以 `/v1` 结尾；不要加 `/chat/completions`，程序会自动补上。 |
| **API key** | 该服务商的 API 密钥。 |
| **Model id** | 这个密钥可调用的准确模型 ID，不是你自己给模型起的昵称。 |
| **Agent display name** | 回复者的显示名称，保留默认 `Margin` 即可。 |

可选的搜索 API key 可以先不填。点 **Save & test connection**，看到
**Connection successful.** 再继续。这个按钮会发一次真实的小请求，可能产生服务商费用；
连接成功不代表该模型的所有工具调用都兼容。

然后**新建一条批注**，例如：

> 请把这句话改得更清楚，先提出修改建议，让我确认。

AI 会在这条批注下面回复。如果出现修改建议卡片，看过后选择 **Accept** 或 **Reject**。
只有一句文字回复，不代表原文已经改过。要追问，继续点 **Reply**。
想让 AI 审阅整篇文档，点 **Grill me**。

Settings 配置的是文档里的独立 AI。它不会自动继承你之前在 Codex、Claude Code 或 Hermes
里的聊天记录；需要原有上下文时，再使用下一节。
已连接原生会话的文档会在 Settings 中显示原生配置，独立 AI 的模型字段不控制该会话。

## 进阶：接着“写出这篇文档的那次聊天”讨论

这是 **0.2.0 已包含的可选实验性集成**，需要本机已安装、已登录的原始 Agent。
这个模式沿用原 Agent 的配置，不使用 Settings 里单独填的模型。

还需要两个准确标识：原始会话 ID，以及交付文档的**已完成回复**的 ID。

| Agent | `--origin-provider` | `--origin-turn` 填什么 |
| --- | --- | --- |
| Codex | `codex` | 已完成的原生 turn ID |
| Claude Code | `claude-code` | 已完成的 assistant message UUID |
| Hermes | `hermes` | 原生数据库的 `messages.id` 行号，不是界面消息序号 |

这些标识要从原 Agent 的运行环境取得，不能用会话标题或“最近一次聊天”代替。拿不到时，先用
普通编辑模式；这不代表已连接原会话。Hermes 还需在原配置中启用[对应插件](plugins/marginote-hermes/README.md)。

装好 Hermes 插件后，让 Agent 在后台终端运行 `hermes marginote report.md` 即可。它会识别当前
会话，等本轮交付结束后自动连接。建议先用 `npm install -g marginote@0.2.0` 持久安装，
再按插件文档完成一次性安装；启动器会从 PATH 找到 `marginote`，自定义位置可用
`hermes marginote --setup /absolute/path/to/marginote` 配置。
不需要另外配置 MCP，也不要为了取得 ID 新开一个聊天，否则只能继承新聊天的内容。

也可以显式指定原会话，将下面的路径、文件名和两个 ID 占位符都换成真实值：

```bash
npx marginote@0.2.0 "/你的项目路径" --doc report.md --port 0 --open --origin-provider codex --origin-session EXACT_SESSION_ID --origin-turn EXACT_COMPLETED_TURN_ID
```

1. 打开命令打印的完整链接。带原会话参数的 CLI 会自动连接；加 `--no-connect` 才保留手动按钮。
2. 确认显示 **Codex conversation · Ready**（或相应 Agent 名称）。Hermes 会显示继承的模型，
   在会话详情中显示复制的消息数量。
3. 新建批注。讨论会在继承上下文的独立子会话中进行，不会把问题发回原聊天。
4. 有建议时选择 **Accept / Reject**；出现 **Your approval needed** 时，查看具体操作，
   再选择 **Approve once**（仅批准这次）或 **Decline**（拒绝）。

每条新请求开始处理时会显示 **👀 received · reading…** 回执。讨论结束用 **Resolve**，
需要继续时用 **Reopen**；批注和历史回复都会保留。

开始连接前的旧批注不会自动执行；等待连接期间和连接后的新批注、追问会在连接完成后处理。这个模式下 **Grill me**
会隐藏。仅打开链接或点连接不会开始模型推理。

同一个文件夹只能由一个 Marginote 服务打开。若已有服务，请复用它的链接，或由已连接 MCP
的 Agent 使用 `review_document` 生成链接，不要重复启动。

本地原生端到端测试已通过 Codex **0.151.0**、Claude Code **2.1.243**（SDK **0.3.272**）和
Hermes **0.21.3**，模型响应由本地测试服务模拟；Codex 另有真实模型流程验证。
这不代表所有模型服务商或未来 Agent 版本都已验证，升级 Agent 后应重跑兼容性检查。
通过 Marginote 提交的建议要经你接受；原 Agent 的其他文件工具仍保留原权限。
详细设置与限制见[会话说明](docs/artifact-conversations.md)。

## 遇到问题先看这里

| 问题 | 检查方法 |
| --- | --- |
| 找不到 `node` 或 `npx` | 安装带 npm 的 Node.js 22+ 后，重新打开终端。 |
| 网页打不开 | 启动命令要一直运行；用终端打印的准确地址。端口占用时给命令加 `--port 4322`。 |
| 左侧没有文档 | 确认打开的文件夹中有 `.md`、`.html` 或 `.tex` 文件；`--doc` 相对于该文件夹。 |
| **Comment** 点不了 | 先在源码编辑区选中文字。 |
| 批注没人回复 | 内置 AI 先测试 Settings，再发新批注；原生会话检查是否 Ready、等待批准或报错。 |
| 没有 **Connect conversation** | CLI 现在自动连接，先看是否显示 **Ready / Connecting**。手动链接要带文档和原会话 ID；普通编辑链接不会绑定聊天。 |
| `Web client not found` | 源码版需要先运行 `npm ci` 和 `npm run build`；npm 包已包含网页，请核对实际启动的是哪份安装。 |
| 提示文件夹已被占用 | 复用已有服务，或在原终端按 `Ctrl+C` 停止；崩溃后等待最多两分钟。 |
| HTML 样式或 LaTeX 预览不完整 | 查看 [HTML 支持范围](docs/html-artifacts.md)或 [LaTeX 环境要求](docs/latex-and-images.md)。 |

## 文件保存在哪里？怎么退出？

正文保存在你打开的文件夹。批注、AI 设置和会话绑定保存在其中的 `.marginote/` 下，
不要把这个目录公开或提交到版本库。密钥以仅所有者可读写的权限保存。

AI 会把相关文档内容发送给你配置的模型服务商；可选搜索和发现功能也可能访问外部服务。
默认网页只在本机访问。退出时在启动终端按 `Ctrl+C`：普通工作文件保留，演示文件会删除。

Docker、开发验证和其他命令见 [English README](README.md#development-and-docker)。
