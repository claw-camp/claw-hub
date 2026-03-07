/**
 * 飞书集成模块
 * 处理飞书消息的接收、Session 管理、Agent 通信、回复发送
 */

const crypto = require('crypto');

/**
 * 生成唯一 ID
 */
function generateId(prefix = '') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let str = '';
  for (let i = 0; i < 16; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return prefix ? `${prefix}_${str}` : str;
}

/**
 * 飞书集成类
 */
class FeishuIntegration {
  constructor(pool, agents, broadcastChatMessage) {
    this.pool = pool;
    this.agents = agents;  // Map: agentId -> agent info (包含 ws)
    this.broadcastChatMessage = broadcastChatMessage;
    this.pendingResponses = new Map();  // 等待 Agent 回复的消息
    this.botConfigs = new Map();  // 缓存 bot 配置
    
    // 加载飞书配置（从环境变量）
    this.feishuConfigs = this.loadFeishuConfigs();
  }
  
  /**
   * 加载飞书配置
   * 支持多个飞书应用
   */
  loadFeishuConfigs() {
    const configs = new Map();
    
    // 大龙虾（主机器人）
    if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
      configs.set('main', {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        encryptKey: process.env.FEISHU_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN
      });
    }
    
    // 大龙虾研发（研发专用）
    if (process.env.FEISHU_DEV_APP_ID && process.env.FEISHU_DEV_APP_SECRET) {
      configs.set('dev', {
        appId: process.env.FEISHU_DEV_APP_ID,
        appSecret: process.env.FEISHU_DEV_APP_SECRET,
        encryptKey: process.env.FEISHU_DEV_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU_DEV_VERIFICATION_TOKEN
      });
    }
    
    console.log(`[Feishu] 已加载 ${configs.size} 个飞书配置`);
    return configs;
  }
  
  /**
   * 验证飞书请求签名
   */
  verifySignature(timestamp, nonce, body, signature, configKey = 'main') {
    const config = this.feishuConfigs.get(configKey);
    if (!config || !config.encryptKey) return true;  // 未配置则跳过验证
    
    const token = config.verificationToken;
    const str = timestamp + nonce + token + body;
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return hash === signature;
  }
  
  /**
   * 处理飞书 Webhook 请求
   */
  async handleWebhook(req, res) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        // URL 验证（首次配置时）
        if (data.type === 'url_verification') {
          console.log('[Feishu] URL 验证请求');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challenge: data.challenge }));
          return;
        }
        
        // 处理消息事件
        if (data.header?.event_type === 'im.message.receive_v1') {
          await this.handleMessage(data);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
      } catch (e) {
        console.error('[Feishu] Webhook 处理失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }
  
  /**
   * 处理飞书消息
   */
  async handleMessage(event) {
    const { event: msgEvent } = event;
    const { message } = msgEvent;
    
    const openId = message.sender?.id?.open_id;
    const chatId = message.chat_id;
    const msgType = message.message_type;
    const content = message.content;
    const msgId = message.message_id;
    
    if (!openId || !chatId) {
      console.warn('[Feishu] 消息缺少必要字段');
      return;
    }
    
    console.log(`[Feishu] 收到消息: ${openId} -> ${chatId} [${msgType}]`);
    
    // 1. 根据 chatId 查找对应的 bot（从 bots 表）
    const bot = await this.findBotByChatId(chatId);
    if (!bot) {
      console.warn(`[Feishu] 未找到 chatId=${chatId} 对应的 bot`);
      return;
    }
    
    // 2. 创建或复用会话
    const conversationId = await this.getOrCreateConversation(bot.bot_id, openId);
    
    // 3. 保存用户消息
    await this.saveUserMessage(conversationId, openId, content, msgType);
    
    // 4. 创建 Session 标识
    const sessionKey = `main:direct:${openId}`;
    
    // 5. 转发给 Agent
    await this.forwardToAgent(bot.bot_id, {
      sessionKey,
      conversationId,
      openId,
      chatId,
      content: this.parseContent(content, msgType),
      msgType,
      msgId
    });
  }
  
  /**
   * 根据 chatId 查找 bot
   */
  async findBotByChatId(chatId) {
    if (!this.pool) return null;
    
    // 这里假设 chat_id 格式为 "bot_xxx" 或者在 bots 表中有映射
    // 实际需要根据你的业务逻辑调整
    
    // 简单实现：从环境变量或配置读取映射
    // 例如：FEISHU_CHAT_BOT_MAP={"oc_xxx":"bot_main","oc_yyy":"bot_dev"}
    
    const chatBotMap = JSON.parse(process.env.FEISHU_CHAT_BOT_MAP || '{}');
    const botId = chatBotMap[chatId];
    
    if (botId) {
      const [bots] = await this.pool.query(
        'SELECT * FROM bots WHERE bot_id = ? AND is_active = TRUE',
        [botId]
      );
      return bots[0];
    }
    
    // 如果没有映射，尝试使用默认 bot（第一个激活的）
    const [bots] = await this.pool.query(
      'SELECT * FROM bots WHERE is_active = TRUE LIMIT 1'
    );
    return bots[0];
  }
  
  /**
   * 获取或创建会话
   */
  async getOrCreateConversation(botId, openId) {
    if (!this.pool) return generateId('conv');
    
    // 查找现有会话
    const [existing] = await this.pool.query(`
      SELECT c.conversation_id 
      FROM conversations c
      JOIN conversation_members cm1 ON c.conversation_id = cm1.conversation_id
      JOIN conversation_members cm2 ON c.conversation_id = cm2.conversation_id
      WHERE c.type = 'bot' 
        AND cm1.user_id = ?
        AND cm2.user_id = ?
    `, [openId, botId]);
    
    if (existing.length > 0) {
      return existing[0].conversation_id;
    }
    
    // 创建新会话
    const conversationId = generateId('conv');
    await this.pool.query(
      'INSERT INTO conversations (conversation_id, type, name, created_by) VALUES (?, ?, ?, ?)',
      [conversationId, 'bot', `Bot Chat - ${openId}`, openId]
    );
    
    // 添加成员
    await this.pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      [conversationId, openId, 'owner']
    );
    await this.pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      [conversationId, botId, 'member']
    );
    
    console.log(`[Feishu] 创建新会话: ${conversationId}`);
    return conversationId;
  }
  
  /**
   * 保存用户消息
   */
  async saveUserMessage(conversationId, openId, content, msgType) {
    if (!this.pool) return;
    
    const messageId = generateId('msg');
    await this.pool.query(
      'INSERT INTO messages (message_id, conversation_id, sender_id, sender_type, content, message_type) VALUES (?, ?, ?, ?, ?, ?)',
      [messageId, conversationId, openId, 'user', content, msgType]
    );
  }
  
  /**
   * 解析消息内容
   */
  parseContent(content, msgType) {
    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(content);
        return parsed.text || content;
      } catch {
        return content;
      }
    }
    return content;  // 其他类型（图片、文件等）暂不处理
  }
  
  /**
   * 转发消息给 Agent
   */
  async forwardToAgent(botId, messageData) {
    // 查找关联的 Agent
    let targetAgent = null;
    for (const [agentId, agent] of this.agents) {
      if (agent.botId === botId && agent.status === 'online') {
        targetAgent = agent;
        break;
      }
    }
    
    if (!targetAgent) {
      console.warn(`[Feishu] Bot ${botId} 没有在线的 Agent`);
      // TODO: 可以调用备用 LLM API 生成回复
      return;
    }
    
    // 发送消息给 Agent
    const request = {
      type: 'feishu-message',
      payload: messageData
    };
    
    // 保存待处理的请求（用于匹配回复）
    this.pendingResponses.set(messageData.msgId, {
      ...messageData,
      agentId: targetAgent.id,
      timestamp: Date.now()
    });
    
    // 通过 WebSocket 发送
    if (targetAgent.ws && targetAgent.ws.readyState === 1) {  // WebSocket.OPEN
      targetAgent.ws.send(JSON.stringify(request));
      console.log(`[Feishu] 已转发消息给 Agent ${targetAgent.id}`);
    } else {
      console.warn(`[Feishu] Agent ${targetAgent.id} 的 WebSocket 不可用`);
    }
  }
  
  /**
   * 处理 Agent 的回复
   */
  async handleAgentReply(msg) {
    const { msgId, reply, sessionKey } = msg.payload || msg;
    
    // 查找对应的请求
    const pending = this.pendingResponses.get(msgId);
    if (!pending) {
      console.warn(`[Feishu] 未找到 msgId=${msgId} 的待处理请求`);
      return;
    }
    
    // 移除待处理
    this.pendingResponses.delete(msgId);
    
    // 保存回复到数据库
    const replyMessageId = generateId('msg');
    await this.pool.query(
      'INSERT INTO messages (message_id, conversation_id, sender_id, sender_type, content, message_type) VALUES (?, ?, ?, ?, ?, ?)',
      [replyMessageId, pending.conversationId, pending.agentId, 'bot', reply, 'text']
    );
    
    // 发送回复到飞书
    await this.sendFeishuMessage(pending.chatId, reply);
    
    // 广播给 WebSocket 客户端
    if (this.broadcastChatMessage) {
      this.broadcastChatMessage(pending.conversationId, {
        message_id: replyMessageId,
        conversation_id: pending.conversationId,
        sender_id: pending.agentId,
        sender_type: 'bot',
        content: reply,
        message_type: 'text',
        created_at: new Date()
      });
    }
    
    console.log(`[Feishu] Agent 回复已发送到飞书`);
  }
  
  /**
   * 发送消息到飞书
   */
  async sendFeishuMessage(chatId, content) {
    // 获取飞书 access_token
    const accessToken = await this.getFeishuAccessToken();
    if (!accessToken) {
      console.error('[Feishu] 无法获取 access_token');
      return;
    }
    
    // 调用飞书 API 发送消息
    const https = require('https');
    
    const postData = JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: content })
    });
    
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'open.feishu.cn',
        port: 443,
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.code === 0) {
              resolve(result);
            } else {
              console.error('[Feishu] 发送消息失败:', result.msg);
              reject(new Error(result.msg));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
  
  /**
   * 获取飞书 access_token
   */
  async getFeishuAccessToken(configKey = 'main') {
    const config = this.feishuConfigs.get(configKey);
    if (!config) {
      console.error(`[Feishu] 未找到配置: ${configKey}`);
      return null;
    }
    
    // 检查缓存的 token（有效期 2 小时，提前 5 分钟刷新）
    const cached = this.tokenCache?.get(configKey);
    if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }
    
    // 获取新 token
    const https = require('https');
    
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret
      });
      
      const req = https.request({
        hostname: 'open.feishu.cn',
        port: 443,
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.tenant_access_token) {
              // 缓存 token
              if (!this.tokenCache) this.tokenCache = new Map();
              this.tokenCache.set(configKey, {
                token: result.tenant_access_token,
                expiresAt: Date.now() + result.expire * 1000
              });
              resolve(result.tenant_access_token);
            } else {
              console.error('[Feishu] 获取 token 失败:', result);
              resolve(null);
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

/**
 * 注册飞书路由
 */
function registerFeishuRoutes(server, pool, agents, broadcastChatMessage) {
  const feishu = new FeishuIntegration(pool, agents, broadcastChatMessage);
  
  // 飞书 Webhook
  server.on('request', async (req, res) => {
    if (req.url === '/api/feishu/webhook' && req.method === 'POST') {
      await feishu.handleWebhook(req, res);
    }
  });
  
  // 返回 feishu 实例，供 handleMessage 使用
  return feishu;
}

module.exports = {
  FeishuIntegration,
  registerFeishuRoutes
};
