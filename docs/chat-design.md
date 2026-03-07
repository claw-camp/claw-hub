# 🦞 龙虾营地 - 聊天功能产品设计文档

**版本**: v1.0  
**日期**: 2026-03-07  
**作者**: 产品设计 Agent  
**项目路径**: `~/.openclaw/workspace/data/project/claw-hub/`

---

## 📋 目录

1. [概述](#概述)
2. [用户故事](#用户故事)
3. [功能设计](#功能设计)
4. [交互流程](#交互流程)
5. [UI 原型描述](#ui-原型描述)
6. [移动端适配](#移动端适配)
7. [技术实现建议](#技术实现建议)
8. [数据模型](#数据模型)
9. [未来规划](#未来规划)

---

## 概述

### 背景

龙虾营地是一个 Agent 监控和管理平台，当前已实现：
- ✅ 后端 API（会话列表、发送消息、消息历史）
- ✅ 前端基础界面（会话列表、聊天窗口）

### 设计目标

构建一个完整的聊天系统，支持：
1. **用户 ↔ 机器人聊天**：用户选择已有 Bot 开始对话，Bot 支持智能回复（可接入 LLM）
2. **用户 ↔ 用户聊天**：用户搜索其他用户并发起对话
3. **群聊功能**：创建群组、邀请成员、群组管理

### 目标用户

- **主要用户**：OpenClaw 使用者（开发者、AI 爱好者）
- **次要用户**：Bot 管理员、团队协作用户

---

## 用户故事

### 1. 用户 ↔ 机器人聊天

#### US-1.1：选择 Bot 开始对话

**作为** 用户  
**我想要** 从 Bot 列表中选择一个 Bot 并开始对话  
**以便于** 我可以与特定的 AI Bot 进行交互  

**验收标准**：
- 可以查看所有可用 Bot 列表（包括在线/离线状态）
- 点击 Bot 可以立即创建或打开现有会话
- 显示 Bot 的基本信息（名称、描述、能力）

#### US-1.2：Bot 智能回复

**作为** 用户  
**我想要** Bot 能够智能回复我的消息  
**以便于** 我可以获得有价值的对话体验  

**验收标准**：
- Bot 能够接收用户消息并生成回复
- 支持多种回复模式（echo、LLM 接入）
- 回复延迟在合理范围内（< 3s）

#### US-1.3：查看 Bot 对话历史

**作为** 用户  
**我想要** 查看与 Bot 的历史对话记录  
**以便于** 我可以回顾之前的交互内容  

**验收标准**：
- 会话列表显示所有 Bot 会话
- 消息历史支持分页加载
- 消息显示时间戳和发送者信息

---

### 2. 用户 ↔ 用户聊天

#### US-2.1：搜索其他用户

**作为** 用户  
**我想要** 通过用户名或 ID 搜索其他用户  
**以便于** 我可以找到想要联系的人  

**验收标准**：
- 支持模糊搜索（用户名）
- 显示搜索结果（头像、用户名、在线状态）
- 搜索结果实时更新

#### US-2.2：发起私聊

**作为** 用户  
**我想要** 向其他用户发起私聊  
**以便于** 我可以与他们进行一对一交流  

**验收标准**：
- 点击用户可以发起或打开现有会话
- 如果会话已存在，直接打开
- 会话创建成功后自动跳转到聊天窗口

#### US-2.3：查看用户资料

**作为** 用户  
**我想要** 查看其他用户的基本信息  
**以便于** 我了解对方的背景  

**验收标准**：
- 显示用户名、注册时间、在线状态
- 显示共同群组（如果有）
- 提供发起聊天按钮

---

### 3. 群聊功能

#### US-3.1：创建群组

**作为** 用户  
**我想要** 创建一个群组并设置名称  
**以便于** 我可以与多人进行交流  

**验收标准**：
- 提供创建群组入口
- 可以设置群组名称和头像
- 创建者自动成为群主

#### US-3.2：邀请成员

**作为** 群主或管理员  
**我想要** 邀请其他用户加入群组  
**以便于** 扩大群组规模  

**验收标准**：
- 可以通过搜索选择用户
- 支持批量邀请
- 被邀请用户收到通知

#### US-3.3：群组管理

**作为** 群主  
**我想要** 管理群组成员和设置  
**以便于** 维护群组秩序  

**验收标准**：
- 可以设置管理员
- 可以移除成员
- 可以修改群组信息（名称、头像）
- 可以解散群组

#### US-3.4：退出群组

**作为** 群成员  
**我想要** 退出群组  
**以便于** 我可以离开不感兴趣的群组  

**验收标准**：
- 提供退出群组选项
- 退出后不再收到群消息
- 群主退出时需要转移群主权限

---

## 功能设计

### 1. 会话列表

**位置**：左侧边栏（桌面端）/ 底部导航（移动端）

**功能**：
- 显示所有会话（Bot、私聊、群聊）
- 按最后消息时间排序
- 显示未读消息数
- 支持会话置顶
- 支持会话删除

**交互**：
- 点击会话 → 打开聊天窗口
- 长按会话 → 显示操作菜单（置顶、删除、静音）

### 2. 新建会话

**入口**：
- 会话列表顶部 "➕ 新对话" 按钮
- Bot 列表页 "💬 聊天" 按钮
- 用户搜索页 "发起聊天" 按钮

**流程**：
1. 选择会话类型（Bot / 私聊 / 群聊）
2. 根据类型选择目标（Bot / 用户 / 多个用户）
3. 创建会话并跳转到聊天窗口

### 3. 聊天窗口

**功能**：
- 显示消息列表（支持滚动、分页加载）
- 输入框（支持文本、表情、文件）
- 发送按钮
- 消息状态（发送中、已发送、已读）

**消息类型**：
- 文本消息
- 图片消息（未来）
- 文件消息（未来）
- 系统消息（群组通知等）

### 4. Bot 聊天增强

**功能**：
- 显示 Bot 在线状态
- 显示 Bot 能力标签
- 支持 Bot 配置（温度、模型选择等）
- 支持 Bot 指令（/help、/clear 等）

### 5. 群组增强

**功能**：
- 群组头像（多人头像合成）
- 群成员列表
- 群组设置页
- @ 提及功能（未来）

---

## 交互流程

### 流程 1：与 Bot 聊天

```
用户点击 "新对话"
    ↓
选择 "Bot 聊天"
    ↓
显示 Bot 列表（带在线状态）
    ↓
用户选择一个 Bot
    ↓
检查是否已有会话
    ├─ 有 → 打开现有会话
    └─ 无 → 创建新会话
    ↓
进入聊天窗口
    ↓
用户输入消息 → 发送
    ↓
Bot 接收消息 → 生成回复
    ↓
显示 Bot 回复
```

### 流程 2：搜索用户并私聊

```
用户点击 "新对话"
    ↓
选择 "私聊"
    ↓
进入用户搜索页
    ↓
用户输入搜索关键词
    ↓
显示搜索结果（用户列表）
    ↓
用户点击某个用户
    ↓
显示用户资料卡片
    ↓
用户点击 "发起聊天"
    ↓
检查是否已有会话
    ├─ 有 → 打开现有会话
    └─ 无 → 创建新会话
    ↓
进入聊天窗口
```

### 流程 3：创建群组

```
用户点击 "新对话"
    ↓
选择 "群聊"
    ↓
进入创建群组页
    ↓
输入群组名称
    ↓
搜索并选择成员
    ↓
点击 "创建群组"
    ↓
创建成功，跳转到群聊窗口
```

### 流程 4：群组管理

```
群主在群聊窗口点击群组信息
    ↓
进入群组设置页
    ↓
选择管理功能：
    ├─ 成员管理 → 查看成员列表
    │   ├─ 设为管理员
    │   ├─ 移除成员
    │   └─ 取消管理员
    ├─ 群组信息 → 修改群名称、头像
    └─ 解散群组 → 确认后解散
```

---

## UI 原型描述

### 1. 会话列表页（桌面端）

```
┌─────────────────────────────────┐
│  💬 消息              ➕ 新对话  │
├─────────────────────────────────┤
│  🤖 大龙虾 Bot                  │
│  你好！我是大龙虾...  14:30  [2] │
├─────────────────────────────────┤
│  👤 张三                        │
│  今天天气怎么样？     13:20     │
├─────────────────────────────────┤
│  👥 技术交流群                  │
│  李四: 新版本发布了吗？ 12:15   │
├─────────────────────────────────┤
│  🤖 小助手 Bot                  │
│  我可以帮你查询...    昨天      │
└─────────────────────────────────┘
```

**设计要点**：
- 会话卡片高度：70px
- 显示：头像、名称、最后消息、时间、未读数
- 未读数：圆形红色徽章
- 在线状态：绿色圆点（Bot/用户）

### 2. 新建会话选择器

```
┌─────────────────────────────────┐
│         选择会话类型            │
├─────────────────────────────────┤
│                                 │
│    🤖 Bot 聊天                  │
│    与 AI Bot 进行对话           │
│                                 │
│    👤 私聊                      │
│    与其他用户一对一聊天          │
│                                 │
│    👥 群聊                      │
│    创建或加入群组                │
│                                 │
└─────────────────────────────────┘
```

**设计要点**：
- 三种类型横向或纵向排列
- 每个选项包含图标、标题、描述
- 点击后进入对应流程

### 3. Bot 选择列表

```
┌─────────────────────────────────┐
│  选择 Bot                  🔍   │
├─────────────────────────────────┤
│  🤖 大龙虾 Bot          ● 在线  │
│  AI 助手，支持多种对话           │
├─────────────────────────────────┤
│  🤖 小助手 Bot          ○ 离线  │
│  专注于技术问题解答              │
├─────────────────────────────────┤
│  🤖 翻译君              ● 在线  │
│  多语言翻译专家                  │
└─────────────────────────────────┘
```

**设计要点**：
- 显示 Bot 头像、名称、描述、在线状态
- 在线状态：绿色圆点（在线）/ 灰色圆点（离线）
- 支持搜索过滤

### 4. 用户搜索页

```
┌─────────────────────────────────┐
│  ← 搜索用户                     │
│  ┌───────────────────────────┐  │
│  │ 🔍 搜索用户名或 ID        │  │
│  └───────────────────────────┘  │
├─────────────────────────────────┤
│  搜索结果（3 人）               │
├─────────────────────────────────┤
│  👤 张三                ● 在线  │
│  注册时间：2026-01-15           │
│                   [发起聊天]    │
├─────────────────────────────────┤
│  👤 张三丰              ○ 离线  │
│  注册时间：2026-02-20           │
│                   [发起聊天]    │
└─────────────────────────────────┘
```

**设计要点**：
- 实时搜索（输入时自动搜索）
- 显示用户头像、用户名、在线状态、注册时间
- 每个结果有 "发起聊天" 按钮

### 5. 聊天窗口（通用）

```
┌─────────────────────────────────┐
│  ← 🤖 大龙虾 Bot       ● 在线   │
├─────────────────────────────────┤
│                                 │
│  🤖 你好！我是大龙虾            │
│                           14:30 │
│                                 │
│                           14:31 │
│              你好，介绍一下自己  │
│                                 │
│  🤖 我是龙虾营地的 AI 助手...   │
│                           14:31 │
│                                 │
├─────────────────────────────────┤
│  📎              [输入消息...]  │
│                        [发送]   │
└─────────────────────────────────┘
```

**设计要点**：
- 顶部：返回按钮、会话名称、在线状态
- 中间：消息列表（左右对齐区分发送者）
- 底部：附件按钮、输入框、发送按钮
- 消息气泡：圆角设计，不同颜色区分发送者

### 6. 创建群组页

```
┌─────────────────────────────────┐
│  ← 创建群组                     │
├─────────────────────────────────┤
│  群组名称                       │
│  ┌───────────────────────────┐  │
│  │ 技术交流群                │  │
│  └───────────────────────────┘  │
│                                 │
│  添加成员                       │
│  ┌───────────────────────────┐  │
│  │ 🔍 搜索用户               │  │
│  └───────────────────────────┘  │
│                                 │
│  已选择（2 人）                 │
│  ┌───┐ ┌───┐                   │
│  │ 👤│ │ 👤│                   │
│  │张三│ │李四│                   │
│  └───┘ └───┘                   │
│                                 │
│  搜索结果                       │
│  👤 王五                ● 在线  │
│  [✓] 已选择                     │
│                                 │
├─────────────────────────────────┤
│         [创建群组]              │
└─────────────────────────────────┘
```

**设计要点**：
- 群组名称输入框
- 成员搜索和选择
- 已选择成员显示（可移除）
- 创建按钮（至少选择 1 个成员）

### 7. 群组设置页

```
┌─────────────────────────────────┐
│  ← 群组设置                     │
├─────────────────────────────────┤
│         [群组头像]              │
│      技术交流群                 │
│      5 人 · 创建于 2026-03-07   │
├─────────────────────────────────┤
│  📝 修改群名称                  │
│  ├─ 技术交流群                  │
├─────────────────────────────────┤
│  👥 成员管理                    │
│  ├─ 张三 (群主)          ● 在线│
│  ├─ 李四 (管理员)        ● 在线│
│  ├─ 王五                ○ 离线 │
│  ├─ 赵六                ● 在线 │
│  └─ 钱七                ○ 离线 │
├─────────────────────────────────┤
│  📤 退出群组                    │
│  🗑️ 解散群组（仅群主可见）      │
└─────────────────────────────────┘
```

**设计要点**：
- 群组基本信息（头像、名称、成员数、创建时间）
- 修改群名称（群主和管理员可操作）
- 成员列表（显示角色、在线状态）
- 成员操作（设为管理员、移除成员）
- 退出群组 / 解散群组

---

## 移动端适配

### 1. 布局调整

**桌面端**：左右分栏（会话列表 + 聊天窗口）  
**移动端**：单页面切换

```
移动端布局：

┌─────────────┐
│  会话列表   │  ← 默认显示
│             │
│             │
│             │
│             │
├─────────────┤
│ 底部导航栏  │
└─────────────┘

点击会话后：

┌─────────────┐
│  ← 会话名称 │  ← 全屏聊天窗口
├─────────────┤
│             │
│  聊天内容   │
│             │
├─────────────┤
│  输入框     │
└─────────────┘
```

### 2. 响应式设计断点

```css
/* 移动端 */
@media (max-width: 768px) {
  .chat-container {
    flex-direction: column;
  }
  
  .conversations-list {
    width: 100%;
    height: 100%;
  }
  
  .chat-window {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1000;
    display: none;
  }
  
  .chat-window.active {
    display: flex;
  }
}
```

### 3. 触摸交互优化

- **会话列表**：长按显示操作菜单（置顶、删除、静音）
- **消息列表**：长按消息显示操作菜单（复制、删除、撤回）
- **返回按钮**：左上角固定位置
- **输入框**：自适应高度（最多 4 行）

### 4. 性能优化

- **虚拟滚动**：消息列表使用虚拟滚动（仅渲染可见区域）
- **分页加载**：滚动到顶部时加载历史消息
- **图片懒加载**：图片消息延迟加载
- **WebSocket 心跳**：保持连接稳定

---

## 技术实现建议

### 1. 前端架构

```
src/
├── components/
│   ├── chat/
│   │   ├── ConversationList.vue      # 会话列表
│   │   ├── ConversationItem.vue      # 会话卡片
│   │   ├── ChatWindow.vue            # 聊天窗口
│   │   ├── MessageList.vue           # 消息列表
│   │   ├── MessageBubble.vue         # 消息气泡
│   │   ├── ChatInput.vue             # 输入框
│   │   ├── NewChatModal.vue          # 新建会话选择器
│   │   ├── BotSelector.vue           # Bot 选择器
│   │   ├── UserSearch.vue            # 用户搜索
│   │   ├── CreateGroup.vue           # 创建群组
│   │   └── GroupSettings.vue         # 群组设置
│   └── common/
│       ├── Avatar.vue                # 头像组件
│       ├── StatusBadge.vue           # 在线状态徽章
│       └── SearchInput.vue           # 搜索输入框
├── stores/
│   ├── chat.js                       # 聊天状态管理
│   └── user.js                       # 用户状态管理
├── api/
│   └── chat.js                       # 聊天 API 封装
└── utils/
    ├── websocket.js                  # WebSocket 封装
    └── message.js                    # 消息处理工具
```

### 2. 状态管理（Pinia/Vuex）

```javascript
// stores/chat.js
export const useChatStore = defineStore('chat', {
  state: () => ({
    conversations: [],       // 会话列表
    currentConversation: null, // 当前会话
    messages: {},            // 消息列表 { conversationId: [messages] }
    unreadCounts: {},        // 未读数 { conversationId: count }
    wsConnected: false       // WebSocket 连接状态
  }),
  
  actions: {
    // 加载会话列表
    async loadConversations() { ... },
    
    // 选择会话
    async selectConversation(conversationId) { ... },
    
    // 加载消息
    async loadMessages(conversationId) { ... },
    
    // 发送消息
    async sendMessage(conversationId, content) { ... },
    
    // 创建会话
    async createConversation(type, target) { ... },
    
    // WebSocket 消息处理
    handleWsMessage(message) { ... }
  }
});
```

### 3. WebSocket 实时通信

```javascript
// utils/websocket.js
class ChatWebSocket {
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    this.ws = null;
    this.reconnectInterval = 5000;
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      console.log('[Chat WS] 已连接');
      this.send({ type: 'subscribe', topic: 'chat' });
    };
    
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.onMessage(message);
    };
    
    this.ws.onclose = () => {
      console.log('[Chat WS] 连接关闭，尝试重连');
      setTimeout(() => this.connect(), this.reconnectInterval);
    };
  }
  
  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
```

### 4. Bot 回复机制

```javascript
// 后端：chat-routes.js 中的 handleBotReply 函数

async function handleBotReply(pool, agents, conversationId, botId, userMessage, userId, username) {
  // 1. 获取 Bot 配置
  const [bots] = await pool.query('SELECT * FROM bots WHERE bot_id = ?', [botId]);
  const bot = bots[0];
  
  // 2. 检查是否有 Agent 在线
  const agentOnline = Array.from(agents.values()).some(
    agent => agent.botId === botId && agent.status === 'online'
  );
  
  if (agentOnline) {
    // 3.1 如果 Agent 在线，通过 WebSocket 转发消息
    // TODO: 实现 Agent WebSocket 消息转发
    // agents.get(botId)?.ws?.send({ type: 'chat_message', conversationId, userMessage });
    
  } else {
    // 3.2 如果 Agent 离线，调用 LLM API
    const reply = await callLLMAPI(bot.model, bot.system_prompt, userMessage);
    
    // 4. 保存回复消息
    await pool.query(
      'INSERT INTO messages (message_id, conversation_id, sender_id, sender_type, content, message_type) VALUES (?, ?, ?, ?, ?, ?)',
      [generateId('msg'), conversationId, botId, 'bot', reply, 'text']
    );
  }
}

// LLM API 调用示例
async function callLLMAPI(model, systemPrompt, userMessage) {
  const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ZHIPU_API_KEY}`
    },
    body: JSON.stringify({
      model: model || 'glm-5',
      messages: [
        { role: 'system', content: systemPrompt || '你是一个友好的 AI 助手。' },
        { role: 'user', content: userMessage }
      ]
    })
  });
  
  const data = await response.json();
  return data.choices[0].message.content;
}
```

---

## 数据模型

### 1. 现有表（已创建）

#### `conversations` - 会话表

```sql
CREATE TABLE conversations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(32) UNIQUE NOT NULL,
  type ENUM('direct', 'group', 'bot') NOT NULL DEFAULT 'direct',
  name VARCHAR(100),
  avatar VARCHAR(255),
  created_by VARCHAR(32) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_created_by (created_by)
);
```

#### `conversation_members` - 会话成员表

```sql
CREATE TABLE conversation_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  role ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member',
  last_read_at TIMESTAMP NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_conversation_user (conversation_id, user_id),
  INDEX idx_user_conversations (user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
```

#### `messages` - 消息表

```sql
CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(32) UNIQUE NOT NULL,
  conversation_id VARCHAR(32) NOT NULL,
  sender_id VARCHAR(32) NOT NULL,
  sender_type ENUM('user', 'bot', 'system') NOT NULL DEFAULT 'user',
  content TEXT NOT NULL,
  message_type ENUM('text', 'image', 'file', 'card') NOT NULL DEFAULT 'text',
  metadata JSON,
  reply_to VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN DEFAULT FALSE,
  INDEX idx_conversation (conversation_id, created_at),
  INDEX idx_sender (sender_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
```

### 2. 扩展表（需要新增）

#### `users` - 用户表（已存在，需扩展）

```sql
ALTER TABLE users 
ADD COLUMN avatar VARCHAR(255),
ADD COLUMN bio TEXT,
ADD COLUMN last_online_at TIMESTAMP NULL,
ADD COLUMN settings JSON;
```

#### `bots` - Bot 表（已存在，需扩展）

```sql
ALTER TABLE bots
ADD COLUMN system_prompt TEXT,
ADD COLUMN model VARCHAR(100) DEFAULT 'glm-5',
ADD COLUMN capabilities JSON,
ADD COLUMN avatar VARCHAR(255),
ADD COLUMN description TEXT;
```

---

## 未来规划

### Phase 2：增强功能（v1.1）

1. **消息增强**
   - 图片消息（支持上传、预览）
   - 文件消息（支持上传、下载）
   - 语音消息（录音、播放）
   - 消息引用/回复
   - 消息撤回（2 分钟内）

2. **Bot 能力**
   - Bot 指令系统（/help、/clear、/config）
   - Bot 配置面板（温度、模型、提示词）
   - Bot 对话历史导出

3. **群组增强**
   - @ 提及功能
   - 群组公告
   - 群组权限管理
   - 群组邀请链接

### Phase 3：高级功能（v1.2）

1. **消息搜索**
   - 全局消息搜索
   - 会话内消息搜索
   - 高级搜索（时间、发送者、关键词）

2. **消息通知**
   - 推送通知（浏览器、移动端）
   - 邮件通知
   - 消息提醒设置

3. **数据统计**
   - 消息统计（发送量、活跃度）
   - Bot 使用统计
   - 群组活跃度分析

4. **安全增强**
   - 端到端加密（可选）
   - 消息审计日志
   - 敏感词过滤

---

## 附录

### A. API 端点汇总

#### 会话管理
- `POST /api/chat/conversation` - 创建会话
- `GET /api/chat/conversations` - 获取会话列表
- `GET /api/chat/conversation/:id/members` - 获取会话成员

#### 消息管理
- `POST /api/chat/message` - 发送消息
- `GET /api/chat/messages/:conversationId` - 获取消息历史

#### 群组管理
- `POST /api/chat/group` - 创建群组
- `POST /api/chat/group/:id/members` - 添加群成员
- `DELETE /api/chat/group/:id/members/:userId` - 移除群成员
- `PUT /api/chat/group/:id` - 更新群组信息
- `DELETE /api/chat/group/:id` - 解散群组

#### 用户搜索
- `GET /api/users/search?query=xxx` - 搜索用户
- `GET /api/users/:userId` - 获取用户信息

#### Bot 管理
- `GET /api/bot/list?userId=xxx` - 获取 Bot 列表
- `POST /api/bot/create` - 创建 Bot
- `GET /api/bot/detail?botId=xxx` - 获取 Bot 详情
- `PUT /api/bot/:botId` - 更新 Bot 配置

### B. WebSocket 消息格式

```javascript
// 客户端 → 服务端
{
  "type": "subscribe",
  "topic": "chat"
}

// 服务端 → 客户端（新消息通知）
{
  "type": "new_message",
  "conversationId": "conv_xxx",
  "message": {
    "message_id": "msg_xxx",
    "sender_id": "user_xxx",
    "sender_type": "user",
    "content": "你好",
    "created_at": "2026-03-07T14:30:00Z"
  }
}

// 服务端 → 客户端（用户上线/离线）
{
  "type": "user_status",
  "userId": "user_xxx",
  "status": "online"  // or "offline"
}
```

### C. 错误码定义

| 错误码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未授权（未登录或 token 失效）|
| 403 | 无权限（不是会话成员、不是群主等）|
| 404 | 资源不存在（会话、用户、Bot 不存在）|
| 409 | 冲突（会话已存在、用户已在群组中）|
| 500 | 服务器内部错误 |

---

## 总结

本文档详细设计了龙虾营地的聊天功能，包括：
- ✅ 13 个用户故事（Bot 聊天、用户聊天、群聊）
- ✅ 5 个核心功能模块（会话列表、新建会话、聊天窗口、Bot 增强、群组增强）
- ✅ 4 个交互流程（Bot 聊天、用户私聊、创建群组、群组管理）
- ✅ 7 个 UI 原型描述（会话列表、新建会话、Bot 选择、用户搜索、聊天窗口、创建群组、群组设置）
- ✅ 移动端适配方案（布局调整、响应式设计、触摸优化）
- ✅ 技术实现建议（前端架构、状态管理、WebSocket、Bot 回复）
- ✅ 数据模型设计（现有表 + 扩展表）
- ✅ 未来规划（Phase 2、Phase 3）

下一步工作：
1. 实现用户搜索 API（`/api/users/search`）
2. 实现群组管理 API（更新群信息、解散群组、成员管理）
3. 前端组件开发（按照上述组件结构）
4. WebSocket 实时通信集成
5. Bot LLM 接入（智谱 AI GLM-5）

---

**文档版本历史**：
- v1.0 (2026-03-07) - 初始版本，完整产品设计
