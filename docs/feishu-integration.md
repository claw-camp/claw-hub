# 龙虾营地聊天系统 - 模拟飞书场景

## 概述

龙虾营地内部实现了一个类似飞书的聊天系统，用于：
1. 用户在营地前端发消息给 Bot
2. Hub 创建/复用 Session（`main:direct:uid_xxx`）
3. Hub 转发消息给 OpenClaw Agent
4. Agent 回复 → Hub → 前端显示

**注意**：这是一个**内部模拟系统**，不涉及真实的飞书 API。

## 架构

```
用户（营地前端）
   ↓ POST /api/chat/message
Hub 保存消息到 DB
   ↓ 查找关联的 Agent
Hub 通过 WebSocket 发送 chat-message
   ↓
OpenClaw Agent（大龙虾）
   ↓ 处理消息，生成回复
Agent 发送 chat-reply
   ↓
Hub 保存回复到 DB
   ↓ 广播
前端通过 WebSocket 接收并显示
```

## Session 设计

Session 标识格式：`{agentId}:{type}:{userId}`

示例：
- `main:direct:uid_001` - 用户 uid_001 与大龙虾的私聊
- `main:group:conv_123` - 群聊 conv_123

## 数据库表结构

### conversations 表
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(64) UNIQUE NOT NULL,
  type ENUM('direct', 'group', 'bot') NOT NULL,
  name VARCHAR(255),
  created_by VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  INDEX idx_conversation_id (conversation_id)
);
```

### messages 表
```sql
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) UNIQUE NOT NULL,
  conversation_id VARCHAR(64) NOT NULL,
  sender_id VARCHAR(32) NOT NULL,
  sender_type ENUM('user', 'bot', 'system') DEFAULT 'user',
  content TEXT,
  message_type ENUM('text', 'image', 'file', 'system') DEFAULT 'text',
  reply_to VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN DEFAULT FALSE,
  INDEX idx_message_id (message_id),
  INDEX idx_conversation_id (conversation_id)
);
```

### conversation_members 表
```sql
CREATE TABLE IF NOT EXISTS conversation_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  role ENUM('owner', 'admin', 'member') DEFAULT 'member',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_read_at TIMESTAMP NULL,
  UNIQUE KEY unique_member (conversation_id, user_id),
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_user_id (user_id)
);
```

### bots 表
```sql
CREATE TABLE IF NOT EXISTS bots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bot_id VARCHAR(32) UNIQUE NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  avatar VARCHAR(255) DEFAULT '🦞',
  token VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  INDEX idx_bot_id (bot_id),
  INDEX idx_token (token)
);
```

## API 接口

### 1. 创建会话
```
POST /api/chat/conversation
Headers: x-camp-key: {user_camp_key}
Body: {
  "type": "bot",
  "botId": "bot_main",
  "name": "与大龙虾的聊天"
}

Response: {
  "success": true,
  "conversation": {
    "conversation_id": "conv_xxx",
    "type": "bot",
    "name": "与大龙虾的聊天",
    ...
  }
}
```

### 2. 发送消息
```
POST /api/chat/message
Headers: x-camp-key: {user_camp_key}
Body: {
  "conversationId": "conv_xxx",
  "content": "你好，大龙虾",
  "messageType": "text"
}

Response: {
  "success": true,
  "message": {
    "message_id": "msg_xxx",
    "conversation_id": "conv_xxx",
    "sender_id": "uid_001",
    "content": "你好，大龙虾",
    ...
  }
}
```

### 3. 获取消息历史
```
GET /api/chat/messages/{conversationId}?limit=50&before={msgId}
Headers: x-camp-key: {user_camp_key}

Response: {
  "success": true,
  "messages": [...]
}
```

### 4. 获取会话列表
```
GET /api/chat/conversations
Headers: x-camp-key: {user_camp_key}

Response: {
  "success": true,
  "conversations": [...]
}
```

## WebSocket 消息格式

### Hub → Agent: chat-message
```json
{
  "type": "chat-message",
  "payload": {
    "msgId": "msg_xxx",
    "sessionKey": "main:direct:uid_001",
    "conversationId": "conv_xxx",
    "userId": "uid_001",
    "username": "蟹老板",
    "content": "你好，大龙虾",
    "msgType": "text",
    "timestamp": 1234567890
  }
}
```

### Agent → Hub: chat-reply
```json
{
  "type": "chat-reply",
  "payload": {
    "msgId": "msg_xxx",
    "conversationId": "conv_xxx",
    "sessionKey": "main:direct:uid_001",
    "reply": "你好！我是大龙虾，有什么可以帮你的？"
  }
}
```

### Hub → 前端: chat-message
```json
{
  "type": "chat-message",
  "payload": {
    "conversationId": "conv_xxx",
    "message_id": "msg_yyy",
    "sender_id": "main",
    "sender_type": "bot",
    "content": "你好！我是大龙虾，有什么可以帮你的？",
    "created_at": "2026-03-07T09:00:00.000Z"
  }
}
```

## OpenClaw Agent 集成

在 OpenClaw Agent 中添加聊天消息处理：

```javascript
// agent.js
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'chat-message') {
    const { sessionKey, content, msgId, conversationId, userId } = msg.payload;
    
    // 1. 创建或复用 session
    // sessionKey 格式：main:direct:uid_xxx
    
    // 2. 处理消息（调用 OpenClaw API 或其他逻辑）
    const reply = await processUserMessage(sessionKey, content);
    
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

## 测试流程

### 1. 准备数据
```sql
-- 创建测试用户
INSERT INTO users (user_id, username, password_hash, camp_key)
VALUES ('uid_001', '蟹老板', 'hash', 'test-key-001');

-- 创建 Bot
INSERT INTO bots (bot_id, user_id, name, token)
VALUES ('bot_main', 'uid_001', '大龙虾', 'secret-token-main');
```

### 2. 启动服务
```bash
# 启动 Hub
cd claw-hub
node src/hub.js

# 启动 Agent（确保 botId 和 token 正确）
```

### 3. 测试消息流
```bash
# 1. 创建会话
curl -X POST http://localhost:8889/api/chat/conversation \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"type":"bot","botId":"bot_main"}'

# 2. 发送消息
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_xxx","content":"你好"}'
```

### 4. 查看日志
```bash
# Hub 日志
[Chat] 已转发消息给 Agent main, session=main:direct:uid_001
[Hub] 收到 Agent 回复: session=main:direct:uid_001, conv=conv_xxx
[Hub] Agent 回复已广播: msg_yyy
```

## 调试技巧

### 1. 检查 Agent 是否在线
```bash
# 访问 Agent 列表 API
curl http://localhost:8889/api/agents
```

### 2. 检查数据库
```sql
-- 查看会话
SELECT * FROM conversations WHERE type = 'bot';

-- 查看消息
SELECT * FROM messages WHERE conversation_id = 'conv_xxx' ORDER BY created_at DESC;
```

### 3. WebSocket 测试
使用 wscat 或浏览器控制台测试：
```javascript
const ws = new WebSocket('ws://localhost:8889');
ws.onopen = () => ws.send(JSON.stringify({type:'subscribe'}));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## 扩展功能

### 1. 群聊支持
- 创建 type='group' 的会话
- 支持多成员管理
- @ 提及功能

### 2. 消息类型扩展
- 图片消息
- 文件消息
- 富文本消息
- 卡片消息

### 3. 已读回执
- 记录 last_read_at
- 显示未读消息数

### 4. 消息撤回
- 软删除（is_deleted=TRUE）
- 通知前端更新

## 安全考虑

1. **用户认证**：通过 `x-camp-key` 验证用户身份
2. **权限检查**：验证用户是否在会话中
3. **Agent Token**：Agent 连接时验证 token
4. **输入验证**：过滤恶意内容

## 性能优化

1. **消息分页**：使用 `limit` 和 `before` 参数
2. **索引优化**：为常用查询添加索引
3. **连接池**：使用 MySQL 连接池
4. **消息压缩**：WebSocket 消息压缩
