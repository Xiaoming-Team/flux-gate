# 🌐 proxy-server

自建内网穿透管理面板，基于 Cloudflare Tunnel + Node.js 代理服务器。

## 功能需求

### 域名与访问

| 域名 | 用途 | 认证方式 |
|------|------|----------|
| `iplab.cc` | 管理界面（首页） | Session Cookie（网页登录） |
| `*.iplab.cc` | 动态代理到内网服务 | Session Cookie（与主域名统一） |

### 核心需求

1. **主域名管理界面** — `iplab.cc` 首页列出所有子域名路由卡片，点击直接跳转；无需单独的 settings 页面
2. **子域名动态路由** — 每个子域名单独配置 IP + 端口，支持任意内网设备
3. **统一认证** — 同一套账号密码，管理页登录一次，所有子域名 Basic Auth 自动带凭据访问
4. **退出登录** — 管理页退出按钮销毁 Session；关闭浏览器窗口可清除 Basic Auth 缓存

### 路由配置

- 在管理页直接添加/删除路由，无需重启服务
- 子域名自动在 Cloudflare DNS 创建 CNAME 记录（通过 `*.iplab.cc` 通配符）
- 支持 WebSocket 代理

## 架构

```
用户请求
  ↓
Cloudflare Tunnel
  ↓  (Cloudflare DNS: *.iplab.cc → Tunnel)
本地 :8080  proxy-server
  ↓  (根据 Host header 子域名查路由)
  ├─ iplab.cc        → 管理界面（Session 认证）
  └─ xxx.iplab.cc   → http://<配置的IP>:<配置的端口>（Basic Auth）
```

## 目录结构

```
proxy-server/
├── server.js        # Express 主服务
├── index.ejs        # 管理首页
├── login.ejs        # 登录页
├── settings.ejs     # 设置页（改密码）
├── auth.json        # 账号密码（仅 PM2 所在机器可读）
└── config.json      # 路由配置
```

## 快速开始

### 首次部署

```bash
cd ~/.openclaw/workspace/projects/proxy-server
npm install

# Cloudflare Tunnel 认证（如未完成）
cloudflared tunnel login

# 创建命名隧道
cloudflared tunnel create iplab

# 配置 DNS 通配符
cloudflared tunnel route dns iplab "*.iplab.cc"
cloudflared tunnel route dns iplab iplab.cc

# 启动服务
pm2 start server.js --name proxy-server
pm2 save
```

### 启动顺序

1. `pm2 start proxy-server` — 代理服务（:8080）
2. `pm2 start cloudflared --name cloudflare-tunnel -- tunnel run iplab` — Tunnel

## 管理命令

```bash
pm2 restart proxy-server      # 重启代理服务
pm2 logs proxy-server         # 查看日志
pm2 logs cloudflare-tunnel    # 查看 Tunnel 日志
```

## 配置文件

### auth.json

```json
{
  "username": "admin",
  "password_hash": "sha256..."
}
```

密码通过 SHA256 哈希存储。修改密码：在管理页设置，或直接编辑此文件并重写哈希值。

### config.json

```json
{
  "routes": [
    {
      "subdomain": "nas",
      "ip": "192.168.1.100",
      "port": "5000",
      "description": "群晖 WebDAV"
    }
  ]
}
```

## 默认账号

- 用户名：`admin`
- 密码：`admin`

**首次部署后请务必修改密码。**

## 认证说明

**统一 Basic Auth**，主域名和所有子域名共用同一套账号密码。

- **所有请求**：浏览器弹出 Basic Auth 框，输入一次后自动记忆
- **目标服务**：由 proxy-server 统一认证，无需各自配置
- **默认账号**：`admin` / `admin`（生产环境务必修改）

## PM2 完整进程列表

| 进程 | 说明 |
|------|------|
| `proxy-server` | 代理 + 管理界面（:8080） |
| `cloudflare-tunnel` | Cloudflare Tunnel（绑定 iplab.cc） |
| `workspace-browser` | Workspace 文件浏览器（:8888） |
| `openclaw-proxy` | OpenClaw 反向代理（:9000/9001） |
| `searxng` | 隐私搜索 |
