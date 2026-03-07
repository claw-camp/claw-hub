# 🦞 龙虾营地 (Claw Hub)

OpenClaw Agent 监控系统 - 实时监控 Agent 状态、Token 消耗、Gateway 健康度、插件版本。

## 组件版本

| 组件 | 名称 | 当前版本 | 说明 |
|------|------|---------|------|
| **Hub** | 龙虾营地 Hub | v1.3.0 | 服务端，部署在服务器 |
| **Agent** | 龙虾营地 Agent | v1.0.0 | 本地客户端，运行在 OpenClaw 环境 |

## 架构

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   本地 Agent    │ ◄───────────────► │    线上 Hub     │
│   (agent.js)    │                    │    (hub.js)     │
├─────────────────┤                    ├─────────────────┤
│ • 采集 Gateway  │                    │ • Dashboard UI  │
│ • 采集会话列表  │                    │ • REST API      │
│ • 采集系统资源  │                    │ • Agent 管理    │
│ • 解析 Token    │                    │ • MySQL 存储    │
│ • 采集插件列表  │                    │                 │
└─────────────────┘                    └─────────────────┘
```

## 功能

- **实时监控**：Agent 状态、Gateway 健康、会话数量
- **Token 统计**：精确到每半小时的 token 消耗（从 .jsonl 解析）
- **系统资源**：CPU、内存使用率
- **插件版本**：显示每个 Agent 已加载的插件及版本
- **数据持久化**：MySQL 存储，支持历史查询
- **WebSocket 推送**：实时更新，无需轮询
- **版本管理**：Hub/Agent 版本显示，支持一键更新

## 🔌 安装 OpenClaw 插件（快速接入）

> 适合已经在用 OpenClaw 的用户，一行命令接入龙虾营地监控。

### 一键安装

```bash
curl -fsSL https://claw-camp-1307257815.cos.ap-guangzhou.myqcloud.com/agent/install.sh | bash
```

安装完成后，Agent 文件位于 `~/.openclaw/agents/claw-agent/`。

### 启动 Agent

```bash
# 前台启动（测试用）
~/.openclaw/agents/claw-agent/start.sh

# 后台运行
nohup ~/.openclaw/agents/claw-agent/start.sh > /tmp/claw-agent.log 2>&1 &
```

**启动成功输出：**
```
🦞 龙虾营地 Agent
   Agent: my-mac (my-mac)
   营地: ws://server.aigc.sx.cn:8889

🦞 连接营地: ws://server.aigc.sx.cn:8889
✅ 已连接
✅ 注册成功: my-mac
```

### 自定义配置

通过环境变量定制你的 Agent：

```bash
export CLAW_HUB_URL=ws://server.aigc.sx.cn:8889   # 营地地址（默认）
export CLAW_AGENT_ID=my-mac                         # Agent ID（默认：主机名）
export CLAW_AGENT_NAME=我的大龙虾                   # 显示名称（默认：主机名）

~/.openclaw/agents/claw-agent/start.sh
```

### 开机自启（macOS）

```bash
# 创建 LaunchAgent plist
cat > ~/Library/LaunchAgents/ai.openclaw.claw-agent.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.claw-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>~/.openclaw/agents/claw-agent/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claw-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claw-agent.error.log</string>
</dict>
</plist>
EOF

# 加载
launchctl load ~/Library/LaunchAgents/ai.openclaw.claw-agent.plist
```

### 开机自启（Linux）

```bash
# 创建 systemd 服务
cat > ~/.config/systemd/user/claw-agent.service << 'EOF'
[Unit]
Description=龙虾营地 Agent
After=network.target

[Service]
ExecStart=/bin/bash ~/.openclaw/agents/claw-agent/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user enable claw-agent
systemctl --user start claw-agent
```

### 验证接入

安装并启动后，访问 [https://camp.aigc.sx.cn](https://camp.aigc.sx.cn) 查看你的 Agent 是否出现在列表中。

---

## 快速开始

### 1. 部署 Hub（服务器端）

```bash
# 克隆仓库
git clone https://github.com/PhosAQy/claw-hub.git
cd claw-hub

# 安装依赖
npm install

# 创建 .env 文件（配置环境变量）
cat > .env << 'EOF'
# 数据库配置
DB_HOST=localhost
DB_PORT=3306
DB_USER=claude
DB_PASSWORD=your_password
DB_NAME=claw_camp

# 更新令牌（用于一键更新）
CLAW_UPDATE_TOKEN=your_secure_token
EOF

# 创建数据库
mysql -u root -p -e "CREATE DATABASE claw_camp CHARACTER SET utf8mb4;"

# 启动
node -r dotenv/config src/hub.js
```

### 2. 运行 Agent（本地）

```bash
# 克隆仓库（或在本地 OpenClaw workspace）
git clone https://github.com/PhosAQy/claw-hub.git
cd claw-hub

# 安装依赖
npm install

# 配置环境变量（可选）
export CLAW_HUB_URL=ws://your-server:8889
export CLAW_AGENT_ID=main
export CLAW_AGENT_NAME=大龙虾

# 启动 Agent
node src/agent.js
```

**启动成功输出：**
```
🦞 龙虾营地 Agent v1.0.0
   Agent: 大龙虾 (main)
   Hub: ws://server.aigc.sx.cn:8889

[Agent] 连接 Hub: ws://server.aigc.sx.cn:8889
[Agent] 已连接到 Hub
[Agent] 注册成功: main
```

### 3. 配置 nginx（HTTPS）

```nginx
server {
    listen 443 ssl;
    server_name camp.aigc.sx.cn;

    ssl_certificate /etc/nginx/ssl/camp.crt;
    ssl_certificate_key /etc/nginx/ssl/camp.key;

    root /var/www/camp;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8889/api/;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8889;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## API

### REST

| 端点 | 说明 |
|------|------|
| `GET /api/agents` | 获取所有 Agent 状态 |
| `GET /api/history?hours=6&agent=main` | 获取 Token 消耗历史 |

### WebSocket

```javascript
// 订阅
ws.send({ type: 'subscribe' });

// 接收
ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.type === 'agents') {
    console.log(data.payload); // Agent 列表
  }
};
```

## Token 数据来源

从 OpenClaw session `.jsonl` 文件解析，每条消息包含：

```json
{
  "type": "message",
  "timestamp": "2026-03-04T10:21:15.079Z",
  "message": {
    "usage": {
      "input": 8493,
      "output": 45,
      "cacheRead": 12160,
      "totalTokens": 20698
    }
  }
}
```

按半小时槽聚合，得到精确的消耗曲线。

## 数据库表

### token_usage

```sql
CREATE TABLE token_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id VARCHAR(100) NOT NULL,
  date DATE NOT NULL,
  time_slot VARCHAR(5) NOT NULL,      -- '10:00', '10:30', ...
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  cache_read BIGINT DEFAULT 0,
  net_tokens BIGINT DEFAULT 0,
  message_count INT DEFAULT 0,
  updated_at BIGINT,
  UNIQUE KEY uk_agent_slot (agent_id, date, time_slot)
);
```

## 截图

访问 `https://camp.aigc.sx.cn` 查看 Dashboard。

## License

MIT
