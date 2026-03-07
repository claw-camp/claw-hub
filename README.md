# 🦞 龙虾营地 (Claw Hub)

OpenClaw Agent 监控系统 - 实时监控你的 AI Agent 状态、Token 消耗、Gateway 健康度。

访问 [camp.aigc.sx.cn](https://camp.aigc.sx.cn) 查看 Dashboard。

> 🔌 **想接入营地？** 安装 OpenClaw 插件：[claw-camp/openclaw-plugin](https://github.com/claw-camp/openclaw-plugin)
> ```bash
> openclaw plugins install openclaw-plugin-claw-camp
> ```

---

## 安装插件，接入营地

### 第一步：安装 Agent

```bash
curl -fsSL https://claw-camp-1307257815.cos.ap-guangzhou.myqcloud.com/agent/install.sh | bash
```

安装完成后，Agent 文件位于 `~/.openclaw/agents/claw-agent/`。

---

### 第二步：启动 Agent

```bash
~/.openclaw/agents/claw-agent/start.sh
```

看到以下输出说明成功连接：

```
🦞 龙虾营地 Agent
   Agent: my-mac (my-mac)
   营地: ws://server.aigc.sx.cn:8889

🦞 连接营地: ws://server.aigc.sx.cn:8889
✅ 已连接
✅ 注册成功: my-mac
```

---

### 第三步：去营地看看

打开 [https://camp.aigc.sx.cn](https://camp.aigc.sx.cn)，你的 Agent 会出现在列表里，实时上报状态。

---

## 自定义配置

默认会用主机名作为 Agent ID 和显示名称。如果想自定义，用环境变量启动：

```bash
CLAW_AGENT_ID=my-mac \
CLAW_AGENT_NAME=我的大龙虾 \
CLAW_HUB_URL=ws://server.aigc.sx.cn:8889 \
~/.openclaw/agents/claw-agent/start.sh
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAW_HUB_URL` | `ws://server.aigc.sx.cn:8889` | 营地地址 |
| `CLAW_AGENT_ID` | 主机名 | Agent 唯一标识 |
| `CLAW_AGENT_NAME` | 主机名 | Dashboard 显示名称 |

---

## 后台运行 & 开机自启

**临时后台运行：**

```bash
nohup ~/.openclaw/agents/claw-agent/start.sh > /tmp/claw-agent.log 2>&1 &
```

**macOS 开机自启（LaunchAgent）：**

```bash
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

launchctl load ~/Library/LaunchAgents/ai.openclaw.claw-agent.plist
```

**Linux 开机自启（systemd）：**

```bash
mkdir -p ~/.config/systemd/user
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

---

## 监控内容

Agent 会持续上报以下数据：

- **Gateway 状态**：运行 / 停止
- **会话列表**：当前活跃会话数、Token 消耗
- **系统资源**：CPU、内存使用率
- **已加载插件**：插件名称和版本

---

## 自建 Hub（可选）

如果你想自己部署一套营地，而不是接入公共服务器：

```bash
git clone https://github.com/claw-camp/claw-hub.git
cd claw-hub
npm install

# 创建 .env
cat > .env << 'EOF'
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=claw_camp
CLAW_UPDATE_TOKEN=your_secure_token
EOF

mysql -u root -p -e "CREATE DATABASE claw_camp CHARACTER SET utf8mb4;"
node -r dotenv/config src/hub.js
```

然后把 Agent 的 `CLAW_HUB_URL` 指向你自己的服务器即可。

详细 nginx 配置、API 文档等见 [Wiki](https://github.com/claw-camp/claw-hub/wiki)（待补充）。

---

## License

MIT
