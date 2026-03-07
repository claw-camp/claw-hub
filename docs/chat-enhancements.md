# 聊天功能增强 - 测试文档

## ✅ 已完成功能

### 1. 消息撤回（P0）
**API**: `DELETE /api/chat/message/:messageId`

**测试**：
```bash
# 发送消息
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_xxx","content":"测试消息"}'
# 返回：{"success":true,"message":{"message_id":"msg_xxx",...}}

# 撤回消息（2分钟内）
curl -X DELETE http://localhost:8889/api/chat/message/msg_xxx \
  -H "x-camp-key: test-key-001"
# 返回：{"success":true}
```

**WebSocket 通知**：
```json
{
  "type": "message-recalled",
  "payload": {
    "messageId": "msg_xxx",
    "conversationId": "conv_xxx",
    "recalledAt": "2026-03-07T01:30:00.000Z"
  }
}
```

**限制**：
- 只能撤回自己的消息
- 只能撤回 2 分钟内的消息

---

### 2. 图片上传（P0）
**API**: `POST /api/chat/upload`

**测试**：
```bash
# 上传图片
curl -X POST http://localhost:8889/api/chat/upload \
  -H "x-camp-key: test-key-001" \
  -F "image=@test.jpg"
# 返回：{"success":true,"url":"https://...","size":12345}
```

**发送图片消息**：
```bash
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{
    "conversationId":"conv_xxx",
    "content":"{\"url\":\"https://...\",\"width\":800,\"height\":600}",
    "messageType":"image"
  }'
```

**配置**：
- 文件大小限制：10MB
- 支持格式：所有图片类型（image/*）
- 存储位置：腾讯云 COS

---

### 3. 已读回执（P1）
**API 1**: `POST /api/chat/message/:messageId/read` - 标记已读

**测试**：
```bash
curl -X POST http://localhost:8889/api/chat/message/msg_xxx/read \
  -H "x-camp-key: test-key-002"
# 返回：{"success":true}
```

**API 2**: `GET /api/chat/message/:messageId/reads` - 获取已读列表

**测试**：
```bash
curl http://localhost:8889/api/chat/message/msg_xxx/reads \
  -H "x-camp-key: test-key-001"
# 返回：{"success":true,"reads":[{"user_id":"uid_002","read_at":"..."}]}
```

**WebSocket 通知**（通知发送者）：
```json
{
  "type": "chat-message",
  "payload": {
    "type": "message-read",
    "message_id": "msg_xxx",
    "user_id": "uid_002",
    "read_at": "2026-03-07T01:35:00.000Z"
  }
}
```

---

### 4. @ 提及（P1）
**自动解析**：从消息内容中解析 `@用户名`

**手动指定**：
```bash
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{
    "conversationId":"conv_xxx",
    "content":"@蟹老板 你好",
    "mentions":["uid_002"],
    "mentionAll":false
  }'
```

**@ 全体成员**：
```bash
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{
    "conversationId":"conv_xxx",
    "content":"@全体成员 开会了",
    "mentionAll":true
  }'
```

**API**: `GET /api/chat/mentions` - 获取我被 @ 的消息

**测试**：
```bash
curl http://localhost:8889/api/chat/mentions \
  -H "x-camp-key: test-key-002"
# 返回：{"success":true,"mentions":[...]}
```

**WebSocket 通知**（被 @ 的用户）：
```json
{
  "type": "chat-message",
  "payload": {
    "conversationId": "conv_xxx",
    "message_id": "msg_xxx",
    "mentions": ["uid_002"],
    "mentionAll": false
  }
}
```

---

## 🗄️ 数据库表结构

### message_reads（已读记录）
```sql
CREATE TABLE message_reads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_read (message_id, user_id),
  INDEX idx_message_id (message_id),
  INDEX idx_user_id (user_id)
);
```

### message_mentions（提及记录）
```sql
CREATE TABLE message_mentions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  mention_all BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_message_id (message_id),
  INDEX idx_user_id (user_id)
);
```

### messages 表新增字段
```sql
ALTER TABLE messages ADD COLUMN recalled_at TIMESTAMP NULL;
```

---

## 🧪 完整测试流程

### 1. 准备测试数据
```sql
-- 创建测试用户
INSERT INTO users (user_id, username, password_hash, camp_key)
VALUES 
  ('uid_001', '蟹老板', 'hash', 'test-key-001'),
  ('uid_002', '小虾米', 'hash', 'test-key-002');

-- 创建群聊会话
INSERT INTO conversations (conversation_id, type, name, created_by)
VALUES ('conv_test', 'group', '测试群', 'uid_001');

INSERT INTO conversation_members (conversation_id, user_id, role)
VALUES 
  ('conv_test', 'uid_001', 'owner'),
  ('conv_test', 'uid_002', 'member');
```

### 2. 测试消息撤回
```bash
# 1. 发送消息
RESPONSE=$(curl -s -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_test","content":"测试撤回"}')

MSG_ID=$(echo $RESPONSE | jq -r '.message.message_id')

# 2. 立即撤回
curl -X DELETE http://localhost:8889/api/chat/message/$MSG_ID \
  -H "x-camp-key: test-key-001"
```

### 3. 测试图片上传
```bash
# 1. 上传图片
curl -X POST http://localhost:8889/api/chat/upload \
  -H "x-camp-key: test-key-001" \
  -F "image=@test.jpg"

# 2. 发送图片消息
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_test","content":"{\"url\":\"...\"}","messageType":"image"}'
```

### 4. 测试已读回执
```bash
# 1. 发送消息（用户1）
RESPONSE=$(curl -s -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_test","content":"你好"}')

MSG_ID=$(echo $RESPONSE | jq -r '.message.message_id')

# 2. 标记已读（用户2）
curl -X POST http://localhost:8889/api/chat/message/$MSG_ID/read \
  -H "x-camp-key: test-key-002"

# 3. 查看已读列表（用户1）
curl http://localhost:8889/api/chat/message/$MSG_ID/reads \
  -H "x-camp-key: test-key-001"
```

### 5. 测试 @ 提及
```bash
# 1. 发送带 @ 的消息
curl -X POST http://localhost:8889/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: test-key-001" \
  -d '{"conversationId":"conv_test","content":"@小虾米 你好","mentions":["uid_002"]}'

# 2. 查看被 @ 的消息（用户2）
curl http://localhost:8889/api/chat/mentions \
  -H "x-camp-key: test-key-002"
```

---

## 📦 环境变量配置

```bash
# COS 配置（图片上传）
COS_SECRET_ID=your_secret_id
COS_SECRET_KEY=your_secret_key
```

---

## 🎉 总结

### 功能矩阵

| 功能 | API | WebSocket | 数据库 | 状态 |
|------|-----|-----------|--------|------|
| 消息撤回 | DELETE /message/:id | ✅ | recalled_at | ✅ |
| 图片上传 | POST /upload | - | COS | ✅ |
| 已读回执 | POST /message/:id/read | ✅ | message_reads | ✅ |
| @ 提及 | 自动解析 | ✅ | message_mentions | ✅ |

### 协作完成

- **子代理1**：消息撤回 + 图片上传
- **子代理2**：已读回执 + @ 提及
- **主代理**：协调 + 代码整合 + 提交

---

**所有功能已完成并测试通过！** 🎊
