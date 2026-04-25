# ACP Sidecar

Runner 的 HTTP 代理。将 runner 的 stdin/stdout JSON-RPC 2.0 通信封装为 HTTP 接口，供后端无状态调用。

## 工作原理

Sidecar 作为容器 ENTRYPOINT 运行，启动 runner 子进程，通过 stdin/stdout 与其通信，对外暴露 HTTP 接口。

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/rpc` | SSE 流式响应，推送 notifications 和最终 response。用于 `session/prompt` 等需要流式接收的请求。Prompt 串行控制（同一时刻只允许一个） |
| `POST` | `/rpc/fire-and-forget` | 一次性 JSON 响应。用于 `initialize`、`session/new` 等不需要流式的请求。不受串行限制 |
| `GET` | `/rpc/stream` | SSE 长连接，持续推送所有 notifications。用于 Bridge 模式 |
| `GET` | `/health` | 健康检查，返回 runner 状态、PID、运行时长 |
| `POST` | `/shutdown` | 优雅关闭：SIGTERM → 等待退出 → 进程退出 |

## SSE 事件格式

```
event: notification
data: {"jsonrpc":"2.0","method":"session/update","params":{...}}

event: response
data: {"jsonrpc":"2.0","id":1,"result":{...}}

event: error
data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ACP_RUNNER_CMD` | `agent serve` | Runner 启动命令（空格分割） |
| `ACP_SIDECAR_PORT` | `3000` | HTTP 监听端口 |
| `ACP_AUTO_RESTART` | `true` | Runner 崩溃后自动重启 |
| `ACP_REQUEST_TIMEOUT_SEC` | `600` | 请求超时秒数 |
| `ACP_PROMPT_SERIAL` | `true` | `/rpc` 端点 prompt 串行控制 |

## 本地运行

```bash
# 直接运行（runner 不存在会报错，但 HTTP server 正常监听）
node acp-sidecar.js

# 指定 runner 命令
ACP_RUNNER_CMD="claude-code serve" node acp-sidecar.js

# Docker 构建
docker build -t acp-runner .
docker run -p 3000:3000 -e ACP_RUNNER_CMD="agent serve" acp-runner
```
