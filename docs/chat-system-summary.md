# 龙虾营地聊天系统 - 实现总结

## 🎯 目标

在龙虾营地内部实现一个类似飞书的聊天系统：
- 用户在前端发消息给 Bot
- Hub 创建/复用 Session（`main:direct:uid_xxx`）
- Hub 转发消息给 OpenClaw Agent
- Agent 回复 → Hub → 前端显示

## ✅ 已实现

### 1. Hub 端（`src/hub.js`）

#### 新增功能
- ✅ `generateId()` 函数：生成唯一消息 ID
- ✅ `chat-reply` 消息处理：接收 Agent 回复并广播给前端
- ✅ 暴露 `broadcastChatMessage` 到 global

#### 消息处理流程
```javascript
// Agent → Hub: chat-reply
case 'chat-reply':
  // 1. 保存回复到数据库
  // 2. 广播给前端 WebSocket 客户端
```

### 2. 聊天路由（`src/chat-routes.js`）

#### 修改的函数
- ✅ `handleBotReply()`: 转发消息给 Agent

#### 核心逻辑
```javascript
async function handleBotReply(pool, agents, conversationId, botId, userMessage, userId, username) {
  // 1. 查找关联的 Agent
  // 2. 创建 session 标识: main:direct:uid_xxx
  // 3. 通过 WebSocket 发送 chat-message 给 Agent
  // 4. 如果没有 Agent 在线，使用备用回复
}
```

#### 发送给 Agent 的消息格式
```json
{
  "type": "chat-message",
  "payload": {
    "msgId": "msg_xxx",
    "sessionKey": "main:direct:uid_001",
    "conversationId": "conv_xxx",
    "userId": "uid_001",
    "username": "蟹老板",
    "content": "用户消息内容",
    "msgType": "text",
    "timestamp": 1234567890
  }
}
```

### 3. 文档（`docs/feishu-integration.md`）

- ✅ 完整的架构说明
- ✅ 数据库表结构
- ✅ API 接口文档
- ✅ WebSocket 消息格式
- ✅ Agent 集成示例
- ✅ 测试流程
- ✅ 调试技巧

### 4. 测试脚本（`scripts/test-chat.sh`）

- ✅ 创建会话
- ✅ 发送消息
- ✅ 获取消息历史
- ✅ 检查 Agent 状态

## 🔄 完整流程

```
1. 用户在前端发送消息
   ↓
2. POST /api/chat/message
   - 保存用户消息到 DB
   - 调用 handleBotReply()
   ↓
3. handleBotReply()
   - 查找关联的 Agent
   - 创建 session: main:direct:uid_xxx
   - 发送 chat-message 给 Agent (WebSocket)
   ↓
4. Agent 处理消息
   - 接收 chat-message
   - 调用 OpenClaw API 或其他逻辑
   - 生成回复
   - 发送 chat-reply (WebSocket)
   ↓
5. Hub 接收 chat-reply
   - 保存回复到 DB
   - 广播给前端 WebSocket 客户端
   ↓
6. 前端接收并显示回复
   - WebSocket 收到 chat-message
   - 更新 UI
```

## 🔧 OpenClaw Agent 需要做什么

Agent 需要添加消息处理逻辑：

```javascript
// agent.js
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'chat-message') {
    const { sessionKey, content, msgId, conversationId } = msg.payload;
    
    // 1. 创建或复用 session
    // sessionKey 格式：main:direct:uid_xxx
    
    // 2. 处理消息（调用 OpenClaw API）
    const reply = await processMessage(sessionKey, content);
    
    // 3. 发送回复
    ws.send(JSON.stringify({
      type: 'chat-reply',
      payload: {
        msgId,
        conversationId,
        sessionKey,
        reply
      }
    }));
  }
});
```

## 📊 数据库准备

```sql
-- 1. 创建测试用户
INSERT INTO users (user_id, username, password_hash, camp_key)
VALUES ('uid_001', '蟹老板', 'hash', 'test-key-001');

-- 2. 创建 Bot
INSERT INTO bots (bot_id, user_id, name, token)
VALUES ('bot_main', 'uid_001', '大龙虾', 'secret-token-main');
```

## 🚀 启动测试

```bash
# 1. 启动 Hub
cd claw-hub
node src/hub.js

# 2. 启动 Agent（确保 botId 和 token 正确）

# 3. 运行测试
bash scripts/test-chat.sh
```

## 📝 待办事项

### 前端集成
- [ ] 实现聊天界面 UI
- [ ] WebSocket 连接管理
- [ ] 消息列表渲染
- [ ] 发送消息功能

### Agent 集成
- [ ] 添加 chat-message 处理
- [ ] 实现 session 管理
- [ ] 调用 OpenClaw API
- [ ] 发送 chat-reply

### 功能增强
- [ ] 群聊支持
- [ ] 图片/文件消息
- [ ] 已读回执
- [ ] 消息撤回

## 🐛 故障排查

### Agent 不在线
```bash
# 检查 Agent 列表
curl http://localhost:8889/api/agents

# 检查 Agent 日志
# 确保 botId 和 token 正确
```

### 收不到回复
```bash
# 检查 Hub 日志
[Chat] 已转发消息给 Agent main, session=main:direct:uid_001
[Hub] 收到 Agent 回复: session=main:direct:uid_001

# 检查数据库
SELECT * FROM messages WHERE conversation_id = 'conv_xxx';
```

### WebSocket 连接问题
```javascript
// 浏览器控制台测试
const ws = new WebSocket('ws://localhost:8889');
ws.onopen = () => ws.send(JSON.stringify({type:'subscribe'}));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## 📚 相关文件

- `src/hub.js` - Hub 主文件
- `src/chat-routes.js` - 聊天路由
- `docs/feishu-integration.md` - 详细文档
- `scripts/test-chat.sh` - 测试脚本

---

**下一步**：在 OpenClaw Agent 中添加 chat-message 处理逻辑。
