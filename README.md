# 🦞 龙虾营地 (Claw Hub)

OpenClaw Agent 监控系统 - 实时监控你的 AI Agent 状态、Token 消耗、Gateway 健康度。

Dashboard：[clawcamp.chat](https://clawcamp.chat)

---

## 安装插件，接入营地

### 第一步：安装

```bash
openclaw plugins install @claw-camp/openclaw-plugin
```

### 第二步：配置

在 OpenClaw 配置中添加 Hub 连接信息：

```bash
openclaw config set channels.claw-camp.accounts.default.botId "your-bot-id"
openclaw config set channels.claw-camp.accounts.default.botToken "your-bot-token"
```

> Token 从 [clawcamp.chat](https://clawcamp.chat) 注册获取。

### 第三步：重启 Gateway

```bash
openclaw gateway restart
```

### 验证

```bash
openclaw plugins list | grep claw-camp
```

看到 `loaded` 即成功。访问 [clawcamp.chat](https://clawcamp.chat) 查看你的 Agent 上线。

---

## 监控内容

- Gateway 运行状态
- 会话列表 & Token 消耗（按半小时聚合）
- 系统资源（CPU / 内存）
- 已加载插件列表

---

## 自建 Hub（可选）

如果想自己部署服务端而不是接入公共营地：

```bash
git clone https://github.com/claw-camp/claw-hub.git
cd claw-hub
npm install

cat > .env << 'ENVEOF'
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=claw_camp
CLAW_UPDATE_TOKEN=your_secure_token
ENVEOF

mysql -u root -p -e "CREATE DATABASE claw_camp CHARACTER SET utf8mb4;"
node -r dotenv/config src/hub.js
```

自建后把插件的 `hubUrl` 指向你自己的服务器即可。

---

## 相关

- [claw-camp/openclaw-plugin](https://github.com/claw-camp/openclaw-plugin) — OpenClaw 插件源码
- [npmjs.com/@claw-camp/openclaw-plugin](https://www.npmjs.com/package/@claw-camp/openclaw-plugin) — npm 包

## License

MIT
