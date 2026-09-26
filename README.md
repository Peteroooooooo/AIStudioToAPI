# Google AI Studio Build App to API Adapter

中文文档 | [English](README_EN.md)

> 本分支是 Peter 的独立维护版，基于上游 v1.3.5 和格式转换补丁。新增账号自动冷却、重复 401 隔离、手动恢复和独立的 arm64 镜像。仓库更新不会自动替换运行中的容器。部署细节见 [独立版运维说明](docs/zh/fork-operations.md)。

一个将 Google AI Studio Build App 网页端封装为兼容 OpenAI API、Gemini API 和 Anthropic API 的工具。该服务将充当代理，将 API 请求转换为与 AI Studio Build App 应用界面的浏览器交互。

## ✨ 功能特性

- 🔄 **API 兼容性**：同时兼容 OpenAI API、Gemini API 和 Anthropic API 格式
- 🌐 **网页自动化**：使用浏览器自动化技术与 AI Studio Build 交互
- 👥 **多账号支持**：支持多个 Google 账号同时登录，快速切换无需重新登录
- 🔧 **支持工具调用**：OpenAI、Gemini 和 Anthropic 接口均支持 Tool Calls (Function Calling)
- 📝 **模型支持**：通过 AI Studio 访问各种 Gemini 模型，包括生图模型和 TTS 语音合成模型
- 🎨 **主页展示控制**：提供可视化的 Web 控制台，支持账号管理、VNC 登录等操作

## 🚀 快速开始

### 💻 直接运行（Windows / macOS / Linux）

1. 克隆仓库：

   ```bash
   git clone -b stable https://github.com/Peteroooooooo/AIStudioToAPI.git
   cd AIStudioToAPI
   ```

2. 运行快速设置脚本：

   ```bash
   npm run setup-auth
   ```

   自动填充和无交互模式示例请看 [账号自动填充](#-账号自动填充) 部分。

   该脚本将：
   - 自动下载 Camoufox 浏览器（一个注重隐私的 Firefox 分支）
   - 启动浏览器并打开 AI Studio，引导您手动完成登录
   - 在本地保存您的身份验证凭据（auth 文件位于 `/configs/auth`）

   > 💡 **提示：** 如果下载 Camoufox 浏览器失败或等待太久，可以自行点击 [此处](https://github.com/daijro/camoufox/releases/tag/v135.0.1-beta.24) 下载，然后设置环境变量 `CAMOUFOX_EXECUTABLE_PATH` 为可执行文件的路径（支持绝对和相对路径）。

3. 配置文件：

   首次启动会生成 `data/config.json`，以后统一以这个文件为准。已有 `.env` 或 Portainer 环境变量只在首次生成文件时导入一次；之后请在控制台“设置”页或配置文件中修改。API 密钥、控制台密码、监听端口等启动项编辑文件后需重启进程。

   如果服务可从公网访问，请设置自己的 `API_KEYS` 和控制台密码，不要使用默认密钥 `123456`。

4. 启动服务：

   ```bash
   npm start
   ```

   如果已经构建过前端资源，后续只想快速重启服务，可使用：

   ```bash
   npm run quick-start
   ```

   API 服务将在 `http://localhost:7860` 上运行。

### 本地联调

1. 将有效的认证文件放在 `configs/auth/auth-0.json` 等位置。首次运行会生成 `data/config.json`；本地 API 密钥、控制台密码和端口以该文件中的 `startup` 为准。这些路径已被 `.gitignore` 排除。
2. 运行 `npm run dev`，在 `http://127.0.0.1:7860` 检查页面。后端源码和前端页面修改后会自动重新加载，无需部署 Docker。
3. 确认 `http://127.0.0.1:7860/health/ready` 返回 `ready: true`，再运行 `npm run smoke:local` 验证真实 API 输出。默认检查 `gemini-3.8-flash`；Responses 接口示例：`npm run smoke:local -- --responses --effort medium`。

控制台“用量”页会从上游响应的 `usageMetadata` 记录每条请求的输入、输出、思考、总 Token，以及上游报告的缓存输入 Token。请求重试时，每次上游尝试单独记录实际使用的账号和 Token；请求总量汇总各次尝试，账号用量归到实际发出该次尝试的账号。按时间、模型、账号、API 密钥、接口格式、状态码、缓存状态和耗时筛选时，汇总、排行、趋势与明细采用同一筛选条件。页面提供可暂停的 30 秒自动刷新，后台标签页暂停轮询。API 密钥只保存稳定的 HMAC 标识，不保存明文。

上游未报告的 Token 字段显示为“–”，与真实的 0 分开；中断、重试缺少部分用量时会标注为部分上报。旧统计记录无法补算，旧版多账号重试记录的 Token 无法可靠归属某个账号，会列为未归属。本项目没有自行缓存模型回答；“缓存命中”只表示上游明确报告了缓存输入 Token，浏览器上下文复用不算命中。请求记录保存在 `data/usage-stats.jsonl`。

### Gemini 显式缓存

本分支会在成功回答后，后台为足够长的固定系统提示／工具定义和对话历史创建 Gemini `cachedContents`。客户端仍发送完整历史；服务按账号、模型和内容寻找最长相同前缀，仅把新增消息转发给 Gemini。多个新 session 如使用相同系统提示，可以共享固定前缀；旧 session 中途被其他 session 打断后，也能在缓存有效期内继续命中自己的历史前缀。缓存失效时会删除本地映射并用原请求重试一次。

缓存有效期、临近过期续期窗口、最小 Token、历史检查点间隔与资源数量可在设置页热更新。缓存索引位于 `data/gemini-cache-index.json`，只保存请求前缀哈希、资源名和时间，不保存提示词明文；该文件随 `/app/data` 持久化。缓存资源属于创建它的 Google 账号，账号不可用时会按正常路由发送完整请求。Gemini 上游在 `usageMetadata.cachedContentTokenCount` 报告实际命中 Token，Responses 与 Claude 接口也会转出各自的缓存输入字段。

本地真实请求验证：`node scripts/dev/cacheE2eLocal.js` 测 Gemini 多轮及 A→B→A，`node scripts/dev/cacheProtocolLocal.js` 测 Responses 和 Claude 协议，`node scripts/dev/cacheSystemOnlyProbe.js` 测新 session 的共享系统提示。脚本从已忽略的 `data/config.json` 读取密钥，不打印密钥或提示词。运行前确认 `/health/ready` 可用；这些测试会向 Gemini 发送真实请求并建立短期缓存。

推送 `stable` 分支会触发 GitHub Actions 测试；推送 `v*.*.*` 标签才会发布 arm64 镜像。随后在 Portainer 中把镜像标签改为新版本并更新 Stack。

### 网页热更新配置

控制台按“总览、账号、用量、设置、日志”组织。设置页集中修改浏览器上下文上限、请求总尝试次数、账号轮转阈值、超时和模型能力开关；点击“保存并应用”后写入 `data/config.json`。直接编辑该文件也会热加载支持的字段。上下文池容量变更需要后台重平衡，页面会显示当前已初始化数量。启动项仅显示脱敏摘要，修改后需重启；“日志显示条数”只对当前进程生效。运行在 Docker 中时需持久挂载 `/app/data`。启动项与参数语义见 [独立版运维说明](docs/zh/fork-operations.md#运行参数热更新)。

服务启动后，您可以在浏览器中访问 `http://localhost:7860` 打开 Web 控制台主页，在这里可以查看账号状态和服务状态。
请求统计数据会持久化保存到 `/data/usage-stats.jsonl`。

5. 更新到最新版本（已有本地部署时）：

   ```bash
   git pull
   npm install
   npm start
   ```

> ⚠ **注意：** 直接运行不支持通过 VNC 在线添加账号，需要使用 `npm run setup-auth` 脚本添加账号。当前 VNC 登录功能仅在 Docker 容器中可用。

### 🐋 Docker 部署

使用 Docker 部署，无需预先提取身份验证凭据。

#### 🚢 步骤 1：部署容器

##### 🎮️ 方式 1：Docker 命令

```bash
docker run -d \
  --name aistudio-to-api \
  -p 7860:7860 \
  -v /path/to/auth:/app/configs/auth \
  -v /path/to/data:/app/data \
  -e API_KEYS=your-api-key-1,your-api-key-2 \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ghcr.io/peteroooooooo/aistudio-to-api:v1.3.5-peter.5
```

参数说明：

- `-p 7860:7860`：API 服务器端口（如果使用反向代理，强烈建议改成 `127.0.0.1:7860`）
- `-v /path/to/auth:/app/configs/auth`：挂载包含认证文件的目录
- `-v /path/to/data:/app/data`：挂载统计和账号健康状态持久化目录
- `-e API_KEYS`：用于身份验证的 API 密钥列表（使用逗号分隔）
- `-e TZ=Asia/Shanghai`：时区设置（可选，默认使用系统时区）

##### 📦 方式 2：Docker Compose

创建 `docker-compose.yml` 文件：

```yaml
name: aistudio-to-api

services:
  app:
    image: ghcr.io/peteroooooooo/aistudio-to-api:v1.3.5-peter.5
    container_name: aistudio-to-api
    ports:
      # API 服务器端口（如果使用反向代理，强烈建议改成 127.0.0.1:7860）
      - 7860:7860
    restart: unless-stopped
    volumes:
      # 挂载包含认证文件的目录
      - ./auth:/app/configs/auth
      # 挂载统计数据持久化目录
      - ./data:/app/data
    environment:
      # 用于身份验证的 API 密钥列表（使用逗号分隔）
      API_KEYS: your-api-key-1,your-api-key-2
      # 时区设置（可选，默认使用系统时区）
      TZ: Asia/Shanghai
```

##### 🛠️ 方式 3：从源码构建

如果您希望自己构建 Docker 镜像，可以使用以下命令：

1. 构建镜像：

   ```bash
   docker build -t aistudio-to-api .
   ```

2. 运行容器：

   ```bash
   docker run -d \
     --name aistudio-to-api \
     -p 7860:7860 \
     -v /path/to/auth:/app/configs/auth \
     -v /path/to/data:/app/data \
     -e API_KEYS=your-api-key-1,your-api-key-2 \
     -e TZ=Asia/Shanghai \
     --restart unless-stopped \
     aistudio-to-api
   ```

#### 🔑 步骤 2：账号管理

部署后，您需要使用以下方式之一添加 Google 账号：

**方法 1：VNC 登录（推荐）**

- 在浏览器中访问部署的服务地址（例如 `http://your-server:7860`）并点击「添加账号」按钮
- 将跳转到 VNC 页面，显示浏览器实例
- 登录您的 Google 账号，登录完成后点击「保存」按钮
- 账号将自动保存为 `auth-N.json`（N 从 0 开始）

**方法 2：上传认证文件**

- 在本地机器上运行 `npm run setup-auth` 生成认证文件（参考 [直接运行](#-直接运行windows--macos--linux) 的 1 和 2），认证文件在 `/configs/auth`
- 如果已经在 Chrome 中登录 AI Studio，也可以使用独立的 [AI Studio Auth Exporter 扩展](https://github.com/Peteroooooooo/AIStudio-Auth-Exporter)，从对应的 Chrome Profile 导出 JSON，无需重新登录。
- 在网页控制台，点击「上传 Auth」，上传 auth 的 JSON 文件，或手动上传到挂载的 `/path/to/auth` 目录

> 💡 **提示**：您也可以从已有的容器下载 auth 文件，然后上传到新的容器。在网页控制台点击对应账号的「下载 Auth」按钮即可下载 auth 文件。

> ⚠ 目前暂不支持通过环境变量注入认证信息。

#### 🌐 步骤 3（可选）：使用 Nginx 反向代理

如果需要通过域名访问或希望在反向代理层统一管理（例如配置 HTTPS、负载均衡等），可以使用 Nginx。

> 📖 详细的 Nginx 配置说明请参阅：[Nginx 反向代理配置文档](docs/zh/nginx-setup.md)

### 🐾 Claw Cloud Run 部署

> ℹ **Claw Cloud Run 公告：** 自 **2026/05/11 00:00 UTC** 起，Claw Cloud Run 已停止产品及相关服务。详情请参阅官方公告：
> [公告](https://question.run.claw.cloud/questions/10010000000003261)

> 📖 旧版部署教程请参阅：[部署到 Claw Cloud Run](docs/zh/claw-cloud-run.md)

### 🦓 Zeabur 部署

> ℹ **Zeabur 公告：** 自 **2026/03/15** 起，Zeabur 已停止在 **共享集群** 上创建新项目；**已经运行在共享集群上的服务不会受到影响**。详情请参阅官方变更说明：
> [公告](https://zeabur.com/zh-CN/changelogs/phasing-out-shared-cluster)

> 📖 旧版部署教程请参阅：[部署到 Zeabur](docs/zh/zeabur.md)

## 📡 使用 API

### 🤖 OpenAI 兼容 API

此端点处理后转发到 Gemini API 格式端点。

- `GET /v1/models`: 列出模型。
- `POST /v1/chat/completions`: 聊天补全和图片生成，支持非流式、真流式和假流式。
- `POST /v1/embeddings`: 生成文本嵌入向量。
- `POST /v1/responses`: OpenAI Responses API 兼容接口，用于对话生成，不支持图像生成，支持非流式、真流式和假流式。
- `POST /v1/responses/input_tokens`: 计算 OpenAI Responses API 请求的输入 token 数量。

### ♊ Gemini 原生 API 格式

此端点转发到 Gemini API 格式端点。

- `GET /v1beta/models`: 列出可用的 Gemini 模型。
- `POST /v1beta/models/{model_name}:generateContent`: 生成内容、图片和语音。
- `POST /v1beta/models/{model_name}:streamGenerateContent`: 流式生成内容、图片和语音，支持真流式和假流式。
- `POST /v1beta/models/{model_name}:embedContent`: 生成单条文本嵌入向量。
- `POST /v1beta/models/{model_name}:batchEmbedContents`: 批量生成文本嵌入向量。
- `POST /v1beta/models/{model_name}:predict`: Imagen 系列模型图像生成。

### 👤 Anthropic 兼容 API

此端点处理后转发到 Gemini API 格式端点。

- `GET /v1/models`: 列出模型。
- `POST /v1/messages`: 聊天消息补全，支持非流式、真流式和假流式。
- `POST /v1/messages/count_tokens`: 计算消息中的 token 数量。

> 📖 详细的 API 使用示例请参阅：[API 使用示例文档](docs/zh/api-examples.md)

## 🖥️ 推荐前端：AMC WebUI

[AMC WebUI](https://github.com/yeahhe365/AMC-WebUI) 是一款面向 Gemini 的 Local-First AI 工作流 WebUI，集成多模态聊天、Canvas、文件处理、实时搜索、代码执行与高级推理。它已经支持将 AIStudioToAPI 作为第三方 Gemini 兼容后端使用，可以作为本项目的图形化前端。

在线 Demo：[https://all-model-chat.pages.dev](https://all-model-chat.pages.dev)

使用方式：

- 先部署并启动 AIStudioToAPI，确保 Gemini 原生 API 地址可访问，例如 `http://localhost:7860/v1beta`。
- 在 AMC WebUI 中进入 **设置 -> API 配置**，启用“自定义 API 配置”，并将 Gemini 兼容 Base URL 填为 AIStudioToAPI 的 `/v1beta` 地址。
- AMC WebUI 中填写的 API Key 应与 AIStudioToAPI 部署时配置的 `API_KEYS` 对应。

## 🧰 相关配置

### 🔧 旧环境变量的一次性导入

以下变量仅用于首次生成 `data/config.json`，已有配置文件时不再读取。日常修改请使用控制台“设置”页；启动项请编辑配置文件。

#### 📱 应用配置

| 变量名                      | 描述                                                                                                                           | 默认值               |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------- |
| `API_KEYS`                  | 用于身份验证的有效 API 密钥列表（使用逗号分隔）。                                                                              | `123456`             |
| `WEB_CONSOLE_USERNAME`      | 网页控制台登录的用户名（可选）。如果同时设置用户名和密码，登录时需要输入两者。                                                 | 无                   |
| `WEB_CONSOLE_PASSWORD`      | 网页控制台登录的密码（可选）。如果只设置密码，登录页面仅要求输入密码；如果两者都不设置，系统将使用 `API_KEYS` 进行控制台登录。 | 无                   |
| `PORT`                      | API 服务器端口。                                                                                                               | `7860`               |
| `HOST`                      | 服务器监听的主机地址。                                                                                                         | `0.0.0.0`            |
| `ICON_URL`                  | 用于自定义控制台的 favicon 图标。支持 ICO, PNG, SVG 等格式。                                                                   | `/AIStudio_logo.svg` |
| `SECURE_COOKIES`            | 是否启用安全 Cookie。`true` 表示仅支持 HTTPS 协议访问控制台。                                                                  | `false`              |
| `RATE_LIMIT_MAX_ATTEMPTS`   | 时间窗口内控制台允许的最大失败登录尝试次数（设为 `0` 禁用）。                                                                  | `5`                  |
| `RATE_LIMIT_WINDOW_MINUTES` | 速率限制的时间窗口长度（分钟）。                                                                                               | `15`                 |
| `CHECK_UPDATE`              | 是否在页面加载时检查版本更新（设为 `false` 禁用）。                                                                            | `true`               |
| `LOG_LEVEL`                 | 日志输出等级。设为 `DEBUG` 启用详细调试日志。                                                                                  | `INFO`               |
| `TZ`                        | 日志和显示时间使用的时区，例如 `Asia/Shanghai`。留空时默认使用系统时区。                                                       | 系统时区             |

#### 🌐 代理配置

| 变量名                          | 描述                                                                                                                                                                | 默认值    |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------- |
| `INITIAL_AUTH_INDEX`            | 启动时使用的初始身份验证索引。                                                                                                                                      | `0`       |
| `ENABLE_AUTH_UPDATE`            | 是否启用自动保存凭证更新。默认为启用状态，将在每次登录/切换账号成功时以及每 24 小时自动更新 auth 文件。设为 `false` 禁用。                                          | `true`    |
| `MAX_RETRIES`                   | 单次客户端请求的总上游尝试次数，包含首次调用；例如 `3` 表示最多尝试三次。                                                                                           | `3`       |
| `RETRY_DELAY`                   | 两次重试之间的间隔（毫秒）。                                                                                                                                        | `2000`    |
| `STREAM_TIMEOUT_MS`             | 真流式响应相邻数据块之间的超时时间（毫秒），最大 `300000`。                                                                                                         | `60000`   |
| `FAKE_STREAM_TIMEOUT_MS`        | 假流式/非流式缓冲响应的超时时间（毫秒），最大 `300000`。                                                                                                            | `300000`  |
| `SWITCH_ON_USES`                | 自动切换帐户前允许的请求次数（设为 `0` 禁用）。                                                                                                                     | `50`      |
| `FAILURE_THRESHOLD`             | 切换帐户前允许的连续失败次数（设为 `0` 禁用）。                                                                                                                     | `2`       |
| `IMMEDIATE_SWITCH_STATUS_CODES` | 触发立即切换帐户的 HTTP 状态码（逗号分隔，设为空值以禁用）。                                                                                                        | `429,503` |
| `MAX_CONTEXTS`                  | 最大同时登录的账号数量。同时登录的账号切换更快，无需重新登录。数值越大内存消耗越高（约：1 个账号 ~700MB，2 个账号 ~950MB，3 个账号 ~1100MB）。设为 `0` 表示无限制。 | `2`       |
| `HTTP_PROXY`                    | 用于访问 Google 服务的 HTTP 代理地址。                                                                                                                              | 无        |
| `HTTPS_PROXY`                   | 用于访问 Google 服务的 HTTPS 代理地址。                                                                                                                             | 无        |
| `NO_PROXY`                      | 不经过代理的地址列表（逗号分隔）。项目已内置自动绕过本地地址（localhost, 127.0.0.1, ::, ::1, 0.0.0.0），通常无需手动配置本地绕过。                                  | 无        |

#### 🗒️ 其他配置

| 变量名                      | 描述                                                                                                        | 默认值   |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------- | :------- |
| `STREAMING_MODE`            | 流式传输模式。`real` 为真流式，`fake` 为假流式。                                                            | `real`   |
| `ENABLE_USAGE_STATS`        | 是否启用请求统计。默认为启用；设为 `false` 后，不读取本地统计、不写入统计，`/api/usage-stats` 返回空数据。  | `true`   |
| `SAFETY_SETTINGS_THRESHOLD` | 安全设置的等级。官方说明：[Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings?hl=zh-cn) | `OFF`    |
| `FORCE_THINKING`            | 强制为所有请求启用思考模式。                                                                                | `false`  |
| `FORCE_WEB_SEARCH`          | 强制为所有请求启用网络搜索。                                                                                | `false`  |
| `FORCE_CODE_EXECUTION`      | 强制为所有请求启用代码执行。                                                                                | `false`  |
| `FORCE_URL_CONTEXT`         | 强制为所有请求启用 URL 上下文。                                                                             | `false`  |
| `CAMOUFOX_EXECUTABLE_PATH`  | Camoufox 浏览器的可执行文件路径（支持绝对或相对路径）。仅在手动下载浏览器时需配置。                         | 自动检测 |

### ⚡ 账号自动填充

为了简化多个账号的登录流程，您可以通过配置 `users.csv` 文件来实现自动填充：

1. 在项目根目录创建 `users.csv`。
2. 格式为：`email,password,recovery_email,totp_secret`（每行一个，`recovery_email` 和 `totp_secret` 可选）。
3. 运行 `npm run setup-auth` 后按提示选择账号。

> 📖 详细配置说明请参阅：[账号自动填充指南](docs/zh/auto-fill-guide.md)
>
> 💡 **提示**：如果需要无交互执行，可使用 `npm run setup-auth -- --non-interactive --account 1`，或直接传入 `--email` / `--password`。
>
> 💡 **批量添加**：使用 `npm run setup-auth-batch -- --headless` 可按顺序添加 `users.csv` 中的全部账号。

### 🧠 模型列表配置

编辑 `configs/models.json` 以自定义可用模型及其设置。

> 💡 **提示：** 思考参数预留了通过模型后缀名来设置的功能，支持在模型名后面通过 `-THINKING_LEVEL` 或 `(THINKING_LEVEL)` 来设置（`THINKING_LEVEL` 支持 `high`、`low`、`medium`、`minimal`，不区分大小写）。例如：`gemini-3-flash-preview(minimal)` 或 `gemini-3-flash-preview-minimal`。
>
> `gemini-3.8-flash` 在本 fork 中默认发送 `thinkingLevel: HIGH`。优先级是模型名后缀 > Chat 的 `reasoning_effort` / Responses 的 `reasoning.effort` > 请求中显式的 Gemini `thinkingLevel` > 默认 HIGH。该模型只支持 `low`、`medium`、`high`；`minimal` 会返回请求错误。`high`、`xhigh`、`max` 和 `ultra` 均映射为上游 HIGH；`includeThoughts` 独立控制是否返回思考内容。
>
> 真假流式也支持通过模型名后缀覆盖，支持追加 `-real` 或 `-fake`。该后缀优先级高于系统的真假流式，但只会在流式请求中生效。例如：`gemini-3-flash-preview-fake`。若和思考后缀同时使用，真假流后缀应放在思考后缀之后，例如：`gemini-3-flash-preview-minimal-fake` 或 `gemini-3-flash-preview(minimal)-real`。
>
> 联网搜索和代码执行也支持通过模型名后缀强制开启：联网搜索追加 `-search`，代码执行追加 `-code`。例如：`gemini-3-flash-preview-search` 或 `gemini-3-flash-preview-code`。若和其他后缀同时使用，内置工具后缀放在最后；完整组合顺序为“思考 -> 流式 -> 内置工具”，例如：`gemini-3-flash-preview-minimal-search`、`gemini-3-flash-preview-real-code` 或 `gemini-3-flash-preview(minimal)-fake-search-code`。

### 🌐 账号固定代理

在项目根目录创建 `proxylist.txt` 即可启用账号固定代理。每行填写一个 HTTP 代理，支持以下格式：

```text
user:pass@ip:port
ip:port:user:pass
ip:port
http://user:pass@ip:port
```

当 `proxylist.txt` 至少包含一个有效代理时，服务会写入 `proxy_mapping.json`，并为每个有效账号分配第一个空闲代理。只要账号仍然存在、代理也仍然保留在 `proxylist.txt` 中，已有绑定就会继续复用。如果账号或代理被移除，对应的旧映射会自动清理。如果有效账号数量多于代理数量，没有分配到代理的账号将无法启动，直到添加更多代理。

`proxy_mapping.json` 会生成在项目根目录，格式是“账号标识 -> 原始代理行”的 JSON 对象，例如：

```json
{
  "user@example.com": "user:pass@1.2.3.4:8080",
  "auth-1": "5.6.7.8:8080"
}
```

基于 VNC 的账号绑定也会使用固定代理。新的 VNC 登录会先预留一个空闲代理再打开浏览器，账号保存后会把该代理持久化绑定到检测到的账号。如果已启用账号固定代理但没有空闲代理，VNC 会直接返回错误，而不会回退到服务器直连 IP。

账号固定代理使用与 `HTTP_PROXY` / `HTTPS_PROXY` 相同的绕过规则：默认绕过本地地址，也可以通过 `NO_PROXY` 添加自定义绕过项：

```bash
NO_PROXY=internal.example.com,10.0.0.0/8
```

## 📄 许可证

本项目基于 [**ais2api**](https://github.com/Ellinav/ais2api)（作者：[**Ellinav**](https://github.com/Ellinav)）分支开发，并完全沿用上游项目所采用的 CC BY-NC 4.0 许可证，其使用、分发与修改行为均需遵守原有许可证的全部条款，完整许可的内容请参见 [LICENSE](LICENSE) 文件。

## 🤝 贡献者

[![Contributors](https://contrib.rocks/image?repo=iBUHub/AIStudioToAPI)](https://github.com/iBUHub/AIStudioToAPI/graphs/contributors)

感谢所有为本项目付出汗水与智慧的开发者。

---

如果你觉得 AIStudioToAPI 对你有帮助，欢迎给项目点一个 ⭐️！

[![Star History Chart](https://api.star-history.com/svg?repos=iBUHub/AIStudioToAPI&type=date&legend=top-left)](https://www.star-history.com/#iBUHub/AIStudioToAPI&type=date&legend=top-left)
