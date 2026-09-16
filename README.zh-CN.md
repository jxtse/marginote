# Marginote 中文入门

[English](README.md)

**把电脑上的文档放进浏览器，选中一段话提问，再决定是否接受 AI 提出的修改。**

Marginote 是在你电脑上运行的文档编辑器，不需要上传文件。文档文件夹在界面里叫
**vault**，可以直接理解为“工作文件夹”。不配置 AI，也能编辑和批注。

第一次用，先完成下面的“启动 → 批注 → AI 回复”三步。连接已有 Codex 等会话是可选的进阶用法。

## 第一步：启动，看到一篇文档

需要 **Node.js 22 或更新版本**，以及随它安装的 npm。打开 macOS 的“终端”、Windows 的
PowerShell 或 Linux 终端，输入 `node --version` 检查版本。下面的命令都在终端输入，不是在浏览器输入。

### 先体验 Markdown：一条命令

```bash
npx marginote@latest --demo
```

如果提示安装包，确认即可。终端保持打开，把它打印的 `local` 地址复制到浏览器，通常是：

**http://127.0.0.1:4321/**

看到左侧文件列表后，点击 `welcome.md`，就可以继续第二步。

**这是临时演示：按 `Ctrl+C` 停止后，演示文件、批注和设置会被删除。** 想保存自己的工作，
先停止演示，再运行：

```bash
npx marginote@latest
```

默认文件夹是 `~/Documents/Marginote`。首次创建时会放入欢迎文档。你可以将自己的 `.md`
文件放进去，也可以直接打开已有文件夹：

```bash
npx marginote@latest "/你的文档文件夹路径"
```

把引号里的路径换成真实路径。Windows 可以写成 `"C:\Users\你的用户名\Documents\notes"`。

### 要用 HTML、LaTeX 或原有 Agent 会话：使用源码版

**版本区别：** 2026-09-16 核对时，npm 的最新版是 `0.2.0-beta.1`，仍是较早的 Markdown 版本。
仓库虽然也标这个版本号，但已有更多功能。npm 包没有 `--doc`、`--open` 和 `--origin-*`
参数；反复运行 `npx marginote@latest` 不会获得尚未发布的源码功能。

需要这些新功能时，先安装 Git，然后依次执行：

```bash
git clone https://github.com/jxtse/marginote.git
cd marginote
npm ci
npm run build
node packages/cli/bin/marginote.js --demo --open
```

最后一条会打开演示页。如果没有自动打开，用终端打印的地址手动打开。要保存工作，按 `Ctrl+C`
停止演示，再在同一个仓库目录运行：

```bash
node packages/cli/bin/marginote.js --open
```

这会打开持久保存的默认文件夹。想指定文件，例如文件夹中有 `report.md`，用：

```bash
node packages/cli/bin/marginote.js "/你的文档文件夹路径" --doc report.md --open
```

`--doc` 后面是相对于文档文件夹的路径，不是整个绝对路径。也可以换成 `report.html` 或
`main.tex`。LaTeX 的 PDF 预览还需要[额外安装编译器和沙箱](docs/latex-and-images.md)。

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

## 进阶：接着“写出这篇文档的那次聊天”讨论

需要源码版，以及本机已安装、已登录的原始 Agent。这个模式沿用原 Agent 的配置，不使用
Settings 里单独填的模型。

还需要两个准确标识：原始会话 ID，以及交付文档的**已完成回复**的 ID。

| Agent | `--origin-provider` | `--origin-turn` 填什么 |
| --- | --- | --- |
| Codex | `codex` | 已完成的原生 turn ID |
| Claude Code | `claude-code` | 已完成的 assistant message UUID |
| Hermes | `hermes` | 原生数据库的 `messages.id` 行号，不是界面消息序号 |

这些标识要从原 Agent 的运行环境取得，不能用会话标题或“最近一次聊天”代替。拿不到时，先用
普通编辑模式；这不代表已连接原会话。Hermes 还需在原配置中启用[对应插件](plugins/marginote-hermes/README.md)。

在构建过的仓库目录执行下面的命令，将路径、文件名和两个 ID 占位符都换成真实值：

```bash
node packages/cli/bin/marginote.js "/你的项目路径" --doc report.md --port 0 --open --origin-provider codex --origin-session EXACT_SESSION_ID --origin-turn EXACT_COMPLETED_TURN_ID
```

1. 打开命令打印的完整链接，等原 Agent 的交付回复结束。
2. 点 **Connect conversation**，看到 **Codex conversation · Ready**（或相应 Agent 名称）。
3. 新建批注。讨论会在继承上下文的独立子会话中进行，不会把问题发回原聊天。
4. 有建议时选择 **Accept / Reject**；出现 **Your approval needed** 时，查看具体操作，
   再选择 **Approve once**（仅批准这次）或 **Decline**（拒绝）。

连接前的旧批注不会自动执行，连接后的新批注和追问才会触发 Agent。这个模式下 **Grill me**
会隐藏。仅打开链接或点连接不会开始模型推理。

同一个文件夹只能由一个 Marginote 服务打开。若已有服务，请复用它的链接，或由已连接 MCP
的 Agent 使用 `review_document` 生成链接，不要重复启动。

目前 Codex 有真实模型流程验证；Claude Code 和 Hermes 已有原生集成测试，但外部真实模型的
完整续聊仍未验证。通过 Marginote 提交的建议要经你接受；原 Agent 的其他文件工具仍保留原权限。
详细设置与限制见[会话说明](docs/artifact-conversations.md)。

## 遇到问题先看这里

| 问题 | 检查方法 |
| --- | --- |
| 找不到 `node` 或 `npx` | 安装带 npm 的 Node.js 22+ 后，重新打开终端。 |
| 网页打不开 | 启动命令要一直运行；用终端打印的准确地址。端口占用时给命令加 `--port 4322`。 |
| 左侧没有文档 | 确认打开的是包含文件的文件夹；npm 包先用 `.md`，HTML/LaTeX 用源码版。 |
| **Comment** 点不了 | 先在源码编辑区选中文字。 |
| 批注没人回复 | 内置 AI 先测试 Settings，再发新批注；原生会话检查是否 Ready、等待批准或报错。 |
| 没有 **Connect conversation** | 确认是源码版，而且打开了带文档和原始会话 ID 的完整链接。普通编辑链接没有这个按钮。 |
| `Web client not found` | 在克隆的仓库目录运行 `npm ci` 和 `npm run build`。 |
| 提示文件夹已被占用 | 复用已有服务，或在原终端按 `Ctrl+C` 停止；崩溃后等待最多两分钟。 |
| HTML 样式或 LaTeX 预览不完整 | 查看 [HTML 支持范围](docs/html-artifacts.md)或 [LaTeX 环境要求](docs/latex-and-images.md)。 |

## 文件保存在哪里？怎么退出？

正文保存在你打开的文件夹。批注、AI 设置和会话绑定保存在其中的 `.marginote/` 下，
不要把这个目录公开或提交到版本库。密钥以仅所有者可读写的权限保存。

AI 会把相关文档内容发送给你配置的模型服务商；可选搜索和发现功能也可能访问外部服务。
默认网页只在本机访问。退出时在启动终端按 `Ctrl+C`：普通工作文件保留，演示文件会删除。

Docker、开发验证和其他命令见 [English README](README.md#development-and-docker)。
