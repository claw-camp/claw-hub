/**
 * 聊天功能 API 路由
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
 * 注册聊天 API 路由
 */
function registerChatRoutes(server, pool, agents) {
  
  // ──────────────────────────────────────────────
  // 会话管理
  // ──────────────────────────────────────────────
  
  // 创建会话（用户直聊/机器人聊天）
  server.on('request', async (req, res) => {
    if (req.url !== '/api/chat/conversation' || req.method !== 'POST') return;
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { type, targetUserId, botId, name } = JSON.parse(body);
        const campKey = req.headers['x-camp-key'];
        
        // 验证用户
        const [users] = await pool.query(
          'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
          [campKey]
        );
        if (!users.length) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权' }));
          return;
        }
        const userId = users[0].user_id;
        
        let conversationType = type;
        let members = [userId];
        let conversationName = name;
        
        if (type === 'direct' && targetUserId) {
          // 用户直聊
          members.push(targetUserId);
          
          // 检查是否已存在会话
          const [existing] = await pool.query(`
            SELECT c.* FROM conversations c
            JOIN conversation_members m1 ON c.conversation_id = m1.conversation_id
            JOIN conversation_members m2 ON c.conversation_id = m2.conversation_id
            WHERE c.type = 'direct' 
              AND m1.user_id = ? 
              AND m2.user_id = ?
          `, [userId, targetUserId]);
          
          if (existing.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, conversation: existing[0] }));
            return;
          }
          
          // 获取目标用户名
          const [targetUsers] = await pool.query(
            'SELECT username FROM users WHERE user_id = ?',
            [targetUserId]
          );
          conversationName = targetUsers[0]?.username || '聊天';
          
        } else if (type === 'bot' && botId) {
          // 机器人聊天
          conversationType = 'bot';
          members.push(botId);  // botId 作为成员
          
          // 获取 bot 名
          const [bots] = await pool.query(
            'SELECT name FROM bots WHERE bot_id = ? AND is_active = TRUE',
            [botId]
          );
          conversationName = bots[0]?.name || 'Bot';
        }
        
        // 创建会话
        const conversationId = generateId('conv');
        await pool.query(
          'INSERT INTO conversations (conversation_id, type, name, created_by) VALUES (?, ?, ?, ?)',
          [conversationId, conversationType, conversationName, userId]
        );
        
        // 添加成员
        for (const memberId of members) {
          const role = memberId === userId ? 'owner' : 'member';
          await pool.query(
            'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
            [conversationId, memberId, role]
          );
        }
        
        // 获取创建的会话
        const [conversations] = await pool.query(
          'SELECT * FROM conversations WHERE conversation_id = ?',
          [conversationId]
        );
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          conversation: conversations[0]
        }));
        
      } catch (e) {
        console.error('[Chat] 创建会话失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '创建会话失败' }));
      }
    });
  });
  
  // 获取会话列表
  server.on('request', async (req, res) => {
    if (!req.url.startsWith('/api/chat/conversations') || req.method !== 'GET') return;
    
    try {
      const campKey = req.headers['x-camp-key'];
      
      const [users] = await pool.query(
        'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
        [campKey]
      );
      if (!users.length) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权' }));
        return;
      }
      const userId = users[0].user_id;
      
      // 获取用户的所有会话
      const [conversations] = await pool.query(`
        SELECT c.*, 
               cm.role,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id AND m.created_at > COALESCE(cm.last_read_at, '1970-01-01')) as unread_count,
               (SELECT content FROM messages m WHERE m.conversation_id = c.conversation_id ORDER BY created_at DESC LIMIT 1) as last_message,
               (SELECT created_at FROM messages m WHERE m.conversation_id = c.conversation_id ORDER BY created_at DESC LIMIT 1) as last_message_at
        FROM conversations c
        JOIN conversation_members cm ON c.conversation_id = cm.conversation_id
        WHERE cm.user_id = ? AND c.is_active = TRUE
        ORDER BY COALESCE(last_message_at, c.created_at) DESC
      `, [userId]);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, conversations }));
      
    } catch (e) {
      console.error('[Chat] 获取会话列表失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '获取会话列表失败' }));
    }
  });
  
  // ──────────────────────────────────────────────
  // 消息管理
  // ──────────────────────────────────────────────
  
  // 发送消息
  server.on('request', async (req, res) => {
    if (req.url !== '/api/chat/message' || req.method !== 'POST') return;
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { conversationId, content, messageType = 'text', replyTo } = JSON.parse(body);
        const campKey = req.headers['x-camp-key'];
        
        const [users] = await pool.query(
          'SELECT user_id, username FROM users WHERE camp_key = ? AND is_active = TRUE',
          [campKey]
        );
        if (!users.length) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权' }));
          return;
        }
        const userId = users[0].user_id;
        const username = users[0].username;
        
        // 验证用户是否在会话中
        const [members] = await pool.query(
          'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
          [conversationId, userId]
        );
        if (!members.length) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无权发送消息' }));
          return;
        }
        
        // 保存消息
        const messageId = generateId('msg');
        await pool.query(
          'INSERT INTO messages (message_id, conversation_id, sender_id, sender_type, content, message_type, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [messageId, conversationId, userId, 'user', content, messageType, replyTo || null]
        );
        
        // 获取消息
        const [messages] = await pool.query(
          'SELECT * FROM messages WHERE message_id = ?',
          [messageId]
        );
        const message = messages[0];
        
        // 获取会话类型
        const [convs] = await pool.query(
          'SELECT type FROM conversations WHERE conversation_id = ?',
          [conversationId]
        );
        const convType = convs[0]?.type;
        
        // 如果是机器人会话，触发机器人回复
        if (convType === 'bot') {
          // 获取 bot_id（会话成员中的 bot）
          const [botMembers] = await pool.query(
            'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id LIKE "bot_%"',
            [conversationId]
          );
          
          if (botMembers.length > 0) {
            const botId = botMembers[0].user_id;
            
            // 异步处理机器人回复（不阻塞响应）
            handleBotReply(pool, agents, conversationId, botId, content, userId, username).catch(e => {
              console.error('[Chat] Bot 回复失败:', e.message);
            });
          }
        }
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message }));
        
      } catch (e) {
        console.error('[Chat] 发送消息失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '发送消息失败' }));
      }
    });
  });
  
  // 获取消息历史
  server.on('request', async (req, res) => {
    if (!req.url.startsWith('/api/chat/messages') || req.method !== 'GET') return;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      const conversationId = url.pathname.split('/').pop();
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const before = url.searchParams.get('before');
      const campKey = req.headers['x-camp-key'];
      
      const [users] = await pool.query(
        'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
        [campKey]
      );
      if (!users.length) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权' }));
        return;
      }
      const userId = users[0].user_id;
      
      // 验证用户是否在会话中
      const [members] = await pool.query(
        'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId]
      );
      if (!members.length) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无权查看消息' }));
        return;
      }
      
      // 获取消息
      let query = `
        SELECT m.*, u.username as sender_name
        FROM messages m
        LEFT JOIN users u ON m.sender_id = u.user_id
        WHERE m.conversation_id = ? AND m.is_deleted = FALSE
      `;
      const params = [conversationId];
      
      if (before) {
        query += ' AND m.created_at < (SELECT created_at FROM messages WHERE message_id = ?)';
        params.push(before);
      }
      
      query += ' ORDER BY m.created_at DESC LIMIT ?';
      params.push(limit);
      
      const [messages] = await pool.query(query, params);
      
      // 更新已读时间
      await pool.query(
        'UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?',
        [conversationId, userId]
      );
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        messages: messages.reverse()  // 按时间正序返回
      }));
      
    } catch (e) {
      console.error('[Chat] 获取消息失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '获取消息失败' }));
    }
  });
  
  // ──────────────────────────────────────────────
  // 群聊管理
  // ──────────────────────────────────────────────
  
  // 创建群聊
  server.on('request', async (req, res) => {
    if (req.url !== '/api/chat/group' || req.method !== 'POST') return;
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { name, memberIds = [] } = JSON.parse(body);
        const campKey = req.headers['x-camp-key'];
        
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '群名称不能为空' }));
          return;
        }
        
        const [users] = await pool.query(
          'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
          [campKey]
        );
        if (!users.length) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权' }));
          return;
        }
        const userId = users[0].user_id;
        
        // 创建群聊
        const conversationId = generateId('conv');
        await pool.query(
          'INSERT INTO conversations (conversation_id, type, name, created_by) VALUES (?, ?, ?, ?)',
          [conversationId, 'group', name, userId]
        );
        
        // 添加创建者为 owner
        await pool.query(
          'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
          [conversationId, userId, 'owner']
        );
        
        // 添加其他成员
        for (const memberId of memberIds) {
          if (memberId !== userId) {
            await pool.query(
              'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
              [conversationId, memberId, 'member']
            );
          }
        }
        
        const [conversations] = await pool.query(
          'SELECT * FROM conversations WHERE conversation_id = ?',
          [conversationId]
        );
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, conversation: conversations[0] }));
        
      } catch (e) {
        console.error('[Chat] 创建群聊失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '创建群聊失败' }));
      }
    });
  });
  
  // 添加群成员
  server.on('request', async (req, res) => {
    if (!req.url.match(/\/api\/chat\/group\/[^/]+\/members$/) || req.method !== 'POST') return;
    
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const conversationId = url.pathname.split('/')[4];
        const { memberIds } = JSON.parse(body);
        const campKey = req.headers['x-camp-key'];
        
        const [users] = await pool.query(
          'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
          [campKey]
        );
        if (!users.length) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权' }));
          return;
        }
        const userId = users[0].user_id;
        
        // 验证权限（owner 或 admin）
        const [members] = await pool.query(
          'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
          [conversationId, userId]
        );
        if (!members.length || !['owner', 'admin'].includes(members[0].role)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无权添加成员' }));
          return;
        }
        
        // 添加成员
        for (const memberId of memberIds) {
          await pool.query(
            'INSERT IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
            [conversationId, memberId, 'member']
          );
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        
      } catch (e) {
        console.error('[Chat] 添加成员失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '添加成员失败' }));
      }
    });
  });
  
  // 获取会话成员列表
  server.on('request', async (req, res) => {
    if (!req.url.match(/\/api\/chat\/conversation\/[^/]+\/members$/) || req.method !== 'GET') return;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      const conversationId = url.pathname.split('/')[4];
      const campKey = req.headers['x-camp-key'];
      
      const [users] = await pool.query(
        'SELECT user_id FROM users WHERE camp_key = ? AND is_active = TRUE',
        [campKey]
      );
      if (!users.length) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权' }));
        return;
      }
      
      const [members] = await pool.query(`
        SELECT cm.*, u.username, b.name as bot_name
        FROM conversation_members cm
        LEFT JOIN users u ON cm.user_id = u.user_id
        LEFT JOIN bots b ON cm.user_id = b.bot_id
        WHERE cm.conversation_id = ?
        ORDER BY cm.role = 'owner' DESC, cm.role = 'admin' DESC, cm.joined_at
      `, [conversationId]);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, members }));
      
    } catch (e) {
      console.error('[Chat] 获取成员列表失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '获取成员列表失败' }));
    }
  });
}

/**
 * 处理机器人回复
 */
async function handleBotReply(pool, agents, conversationId, botId, userMessage, userId, username) {
  // 获取 bot 配置
  const [bots] = await pool.query(
    'SELECT * FROM bots WHERE bot_id = ? AND is_active = TRUE',
    [botId]
  );
  
  if (!bots.length) return;
  
  const bot = bots[0];
  
  // 检查是否有 agent 在线
  let targetAgent = null;
  for (const [agentId, agent] of agents) {
    if (agent.botId === botId && agent.status === 'online') {
      targetAgent = agent;
      break;
    }
  }
  
  // 如果有 agent 在线，通过 WebSocket 转发消息
  if (targetAgent && targetAgent.ws && targetAgent.ws.readyState === 1) {
    // 创建 session 标识（模拟飞书场景）
    const sessionKey = `main:direct:${userId}`;
    
    // 生成消息 ID
    const userMsgId = generateId('msg');
    
    // 发送给 Agent
    const request = {
      type: 'chat-message',
      payload: {
        msgId: userMsgId,
        sessionKey,
        conversationId,
        userId,
        username,
        content: userMessage,
        msgType: 'text',
        timestamp: Date.now()
      }
    };
    
    targetAgent.ws.send(JSON.stringify(request));
    console.log(`[Chat] 已转发消息给 Agent ${targetAgent.id}, session=${sessionKey}`);
    return;  // 等待 Agent 回复（通过 feishu-reply 或 chat-reply）
  }
  
  // 如果没有 agent 在线，使用简单回复
  console.log(`[Chat] Bot ${botId} 没有 Agent 在线，使用备用回复`);
  const reply = `你好 ${username}！我是 ${bot.name}。Agent 当前不在线，请稍后再试。`;
  
  // 保存回复消息
  const messageId = generateId('msg');
  await pool.query(
    'INSERT INTO messages (message_id, conversation_id, sender_id, sender_type, content, message_type) VALUES (?, ?, ?, ?, ?, ?)',
    [messageId, conversationId, botId, 'bot', reply, 'text']
  );
  
  // 获取保存的消息
  const [messages] = await pool.query(
    'SELECT * FROM messages WHERE message_id = ?',
    [messageId]
  );
  
  // 广播给前端
  if (global.broadcastChatMessage && messages[0]) {
    global.broadcastChatMessage(conversationId, messages[0]);
  }
  
  console.log(`[Chat] Bot ${botId} 已回复（备用）`);
}

module.exports = { registerChatRoutes };
