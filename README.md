# 🦞 龙虾营地 (Claw Hub)

OpenClaw Agent 监控系统 - 实时监控 Agent 状态、Token 消耗、Gateway 健康度。

## 组件版本

| 组件 | 名称 | 版本 | 说明 |
|------|------|------|------|
| Hub | 龙虾营地 Hub | 见 package.json | 服务端，部署在服务器 |
| Agent | 龙虾营地 Agent | v1.0.0 | 本地客户端，运行在 OpenClaw 环境 |

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
- **数据持久化**：MySQL 存储，支持历史查询
- **WebSocket 推送**：实时更新，无需轮询

## 快速开始

### 1. 部署 Hub（服务器端）

```bash
# 克隆仓库
git clone https://github.com/yourname/claw-hub.git
cd claw-hub

# 安装依赖
npm install

# 配置数据库（修改 hub.js 中的 DB_CONFIG）
# 创建 MySQL 数据库: CREATE DATABASE claw_camp;

# 启动
node src/hub.js
```

### 2. 配置 Agent（本地）

```bash
# 修改 agent.js 中的 CONFIG
const CONFIG = {
  hubUrl: 'ws://your-server:8889',
  agentId: 'main',
  agentName: '大龙虾',
  // ...
};

# 启动
node src/agent.js
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
