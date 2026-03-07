/**
 * 聊天功能 API 路由
 */

const crypto = require('crypto');
const COS = require('cos-nodejs-sdk-v5');
const multer = require('multer');

// 配置 COS 客户端
const cosClient = new COS({
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
});

// COS 配置
const COS_BUCKET = 'openclaw-memory-1307257815';
const COS_REGION = 'ap-guangzhou';

// 配置 multer 用于内存存储（不上传到本地）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB 限制
  },
  fileFilter: (req, file, cb) => {
    // 只允许图片类型
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只支持图片文件'), false);
    }
  }
});

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
 * 转义正则特殊字符
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从消息内容中解析 @ 提及
 * 支持格式: @用户名 或 @全体成员
 */
async function parseMentions(pool, content, conversationId) {
  const mentions = [];
  let mentionAll = false;

  // 检测 @全体成员 或 @all
  if (/@全体成员|@all/i.test(content)) {
    mentionAll = true;
  }

  // 获取会话成员列表
  const [members] = await pool.query(`
    SELECT cm.user_id, u.username, b.name as bot_name
    FROM conversation_members cm
    LEFT JOIN users u ON cm.user_id = u.user_id
    LEFT JOIN bots b ON cm.user_id = b.bot_id
    WHERE cm.conversation_id = ?
  `, [conversationId]);

  // 从成员列表中匹配 @用户名
  if (members && members.length > 0) {
    for (const member of members) {
      const name = member.username || member.bot_name;
      if (name) {
        const regex = new RegExp(`@${escapeRegExp(name)}`, 'g');
        if (regex.test(content)) {
          mentions.push(member.user_id);
        }
      }
    }
  }

  return { mentions, mentionAll };
}

/**
 * 广播已读通知
 */
function broadcastReadNotification(conversationId, messageId, userId) {
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: 'message-read',
      payload: {
        messageId,
        userId,
        readAt: new Date().toISOString()
      }
    });
  }
}

/**
 * 广播提及通知
 */
function broadcastMentionNotification(conversationId, messageId, mentionedUserIds, mentionAll) {
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: 'mention',
      payload: {
        messageId,
        conversationId,
        mentionedUserIds,
        mentionAll
      }
    });
  }
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
        const { conversationId, content, messageType = 'text', replyTo, mentions: inputMentions, mentionAll: inputMentionAll } = JSON.parse(body);
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
        const [memberCheck] = await pool.query(
          'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
          [conversationId, userId]
        );
        if (!memberCheck.length) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无权发送消息' }));
          return;
        }
        
        // 解析 @ 提及（如果前端没传，则从内容解析）
        let mentions = inputMentions || [];
        let mentionAll = inputMentionAll || false;
        
        if (mentions.length === 0 && !mentionAll) {
          const parsed = await parseMentions(pool, content, conversationId);
          mentions = parsed.mentions;
          mentionAll = parsed.mentionAll;
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
        
        // 保存 @ 提及记录
        if (mentions.length > 0 || mentionAll) {
          // 获取所有会话成员（用于 @全体成员）
          let allUserIds = [];
          if (mentionAll) {
            const [allMembers] = await pool.query(
              'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
              [conversationId]
            );
            allUserIds = allMembers.map(m => m.user_id).filter(id => id !== userId);
          }
          
          const usersToMention = mentionAll ? allUserIds : mentions;
          
          for (const mentionedUserId of usersToMention) {
            await pool.query(
              'INSERT INTO message_mentions (message_id, user_id, mention_all) VALUES (?, ?, ?)',
              [messageId, mentionedUserId, mentionAll && allUserIds.includes(mentionedUserId)]
            );
          }
          
          // 广播提及通知
          broadcastMentionNotification(conversationId, messageId, usersToMention, mentionAll);
        }
        
        // 实时广播消息给所有客户端（用户聊天也需要实时推送）
        if (global.broadcastChatMessage && message) {
          global.broadcastChatMessage(conversationId, {
            ...message,
            mentions,
            mentionAll
          });
        }
        
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
  
  // ──────────────────────────────────────────────
  // 已读回执功能
  // ──────────────────────────────────────────────
  
  // 标记消息已读
  server.on('request', async (req, res) => {
    if (!req.url.match(/\/api\/chat\/message\/[^/]+\/read$/) || req.method !== 'POST') return;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      const messageId = url.pathname.split('/')[4];
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
      
      // 获取消息信息
      const [messages] = await pool.query(
        'SELECT m.*, c.type as conv_type FROM messages m JOIN conversations c ON m.conversation_id = c.conversation_id WHERE m.message_id = ?',
        [messageId]
      );
      
      if (!messages.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '消息不存在' }));
        return;
      }
      
      const message = messages[0];
      
      // 验证用户是否在会话中
      const [memberCheck] = await pool.query(
        'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        [message.conversation_id, userId]
      );
      if (!memberCheck.length) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无权标记已读' }));
        return;
      }
      
      // 不能标记自己发的消息为已读
      if (message.sender_id === userId && message.sender_type === 'user') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '不能标记自己的消息为已读' }));
        return;
      }
      
      // 插入已读记录（使用 INSERT IGNORE 避免重复）
      await pool.query(
        'INSERT IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)',
        [messageId, userId]
      );
      
      // 广播已读通知
      broadcastReadNotification(message.conversation_id, messageId, userId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      
    } catch (e) {
      console.error('[Chat] 标记已读失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '标记已读失败' }));
    }
  });
  
  // 获取消息已读列表
  server.on('request', async (req, res) => {
    if (!req.url.match(/\/api\/chat\/message\/[^/]+\/reads$/) || req.method !== 'GET') return;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      const messageId = url.pathname.split('/')[4];
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
      
      // 获取消息信息
      const [messages] = await pool.query(
        'SELECT * FROM messages WHERE message_id = ?',
        [messageId]
      );
      
      if (!messages.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '消息不存在' }));
        return;
      }
      
      const message = messages[0];
      
      // 获取已读用户列表
      const [reads] = await pool.query(`
        SELECT mr.user_id, mr.read_at, u.username
        FROM message_reads mr
        LEFT JOIN users u ON mr.user_id = u.user_id
        WHERE mr.message_id = ?
        ORDER BY mr.read_at ASC
      `, [messageId]);
      
      // 获取会话总成员数（用于计算已读比例）
      const [memberCount] = await pool.query(
        'SELECT COUNT(*) as total FROM conversation_members WHERE conversation_id = ?',
        [message.conversation_id]
      );
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        reads,
        total: memberCount[0].total,
        readCount: reads.length
      }));
      
    } catch (e) {
      console.error('[Chat] 获取已读列表失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '获取已读列表失败' }));
    }
  });
  
  // ──────────────────────────────────────────────
  // @ 提及功能
  // ──────────────────────────────────────────────
  
  // 获取我被 @ 的消息列表
  server.on('request', async (req, res) => {
    if (req.url !== '/api/chat/mentions' || req.method !== 'GET') return;
    
    try {
      const campKey = req.headers['x-camp-key'];
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
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
      
      // 获取我被 @ 的消息
      const [mentions] = await pool.query(`
        SELECT mm.message_id, mm.mention_all, mm.created_at as mentioned_at,
               m.content, m.sender_id, m.conversation_id, m.created_at as message_at,
               u.username as sender_name,
               c.name as conversation_name, c.type as conversation_type
        FROM message_mentions mm
        JOIN messages m ON mm.message_id = m.message_id
        JOIN users u ON m.sender_id = u.user_id
        JOIN conversations c ON m.conversation_id = c.conversation_id
        WHERE mm.user_id = ? AND m.is_deleted = FALSE
        ORDER BY mm.created_at DESC
        LIMIT ? OFFSET ?
      `, [userId, limit, offset]);
      
      // 获取总数
      const [countResult] = await pool.query(`
        SELECT COUNT(*) as total
        FROM message_mentions mm
        JOIN messages m ON mm.message_id = m.message_id
        WHERE mm.user_id = ? AND m.is_deleted = FALSE
      `, [userId]);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        mentions,
        total: countResult[0].total,
        limit,
        offset
      }));
      
    } catch (e) {
      console.error('[Chat] 获取提及列表失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '获取提及列表失败' }));
    }
  });
  
  // ──────────────────────────────────────────────
  // 消息撤回功能
  // ──────────────────────────────────────────────
  
  // 撤回消息
  server.on('request', async (req, res) => {
    if (!req.url.match(/\/api\/chat\/message\/[^/]+$/) || req.method !== 'DELETE') return;
    
    try {
      const url = new URL(req.url, 'http://localhost');
      const messageId = url.pathname.split('/').pop();
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
      
      // 获取消息
      const [messages] = await pool.query(
        'SELECT * FROM messages WHERE message_id = ?',
        [messageId]
      );
      
      if (!messages.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '消息不存在' }));
        return;
      }
      
      const message = messages[0];
      
      // 验证是否是自己的消息
      if (message.sender_id !== userId || message.sender_type !== 'user') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '只能撤回自己的消息' }));
        return;
      }
      
      // 验证是否在2分钟内
      const messageTime = new Date(message.created_at).getTime();
      const now = Date.now();
      const twoMinutes = 2 * 60 * 1000;
      
      if (now - messageTime > twoMinutes) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '只能撤回2分钟内的消息' }));
        return;
      }
      
      // 验证消息是否已删除
      if (message.is_deleted) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '消息已被撤回' }));
        return;
      }
      
      // 标记消息为已删除（撤回）
      await pool.query(
        'UPDATE messages SET is_deleted = TRUE WHERE message_id = ?',
        [messageId]
      );
      
      // 广播撤回通知给所有客户端
      if (global.broadcastChatEvent) {
        global.broadcastChatEvent(message.conversation_id, {
          type: 'message-recalled',
          payload: {
            messageId,
            conversationId: message.conversation_id,
            recalledBy: userId,
            recalledAt: new Date().toISOString()
          }
        });
      }
      
      console.log(`[Chat] 消息 ${messageId} 已被用户 ${userId} 撤回`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '消息已撤回' }));
      
    } catch (e) {
      console.error('[Chat] 撤回消息失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '撤回消息失败' }));
    }
  });
  
  // ──────────────────────────────────────────────
  // 图片上传功能
  // ──────────────────────────────────────────────
  
  // 上传图片
  server.on('request', async (req, res) => {
    if (req.url !== '/api/chat/upload' || req.method !== 'POST') return;
    
    const campKey = req.headers['x-camp-key'];
    
    // 验证用户
    try {
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
      
      // 使用 multer 处理文件上传
      upload.single('image')(req, res, async (err) => {
        if (err) {
          console.error('[Chat] 上传处理错误:', err.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || '上传失败' }));
          return;
        }
        
        if (!req.file) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请选择图片文件' }));
          return;
        }
        
        try {
          // 生成唯一文件名
          const ext = req.file.originalname.split('.').pop() || 'jpg';
          const timestamp = Date.now();
          const randomStr = crypto.randomBytes(8).toString('hex');
          const fileName = `chat-images/${timestamp}_${randomStr}.${ext}`;
          
          // 上传到 COS
          const uploadResult = await new Promise((resolve, reject) => {
            cosClient.putObject({
              Bucket: COS_BUCKET,
              Region: COS_REGION,
              Key: fileName,
              Body: req.file.buffer,
              ContentType: req.file.mimetype,
            }, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });
          
          // 构建访问 URL
          const imageUrl = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${fileName}`;
          
          console.log(`[Chat] 用户 ${userId} 上传图片成功: ${imageUrl}`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            url: imageUrl,
            fileName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype
          }));
          
        } catch (uploadErr) {
          console.error('[Chat] COS 上传失败:', uploadErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '图片上传失败' }));
        }
      });
      
    } catch (e) {
      console.error('[Chat] 上传图片失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '上传图片失败' }));
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

// ──────────────────────────────────────────────
// 消息撤回功能
// ──────────────────────────────────────────────

server.on('request', async (req, res) => {
  if (!req.url.match(/\/api\/chat\/message\/[^/]+$/) || req.method !== 'DELETE') return;
  
  try {
    const url = new URL(req.url, 'http://localhost');
    const messageId = url.pathname.split('/').pop();
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
    
    // 获取消息
    const [messages] = await pool.query(
      'SELECT * FROM messages WHERE message_id = ?',
      [messageId]
    );
    
    if (!messages.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '消息不存在' }));
      return;
    }
    
    const message = messages[0];
    
    // 验证权限：只能撤回自己的消息
    if (message.sender_id !== userId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '只能撤回自己的消息' }));
      return;
    }
    
    // 验证时间：只能撤回 2 分钟内的消息
    const messageTime = new Date(message.created_at).getTime();
    const now = Date.now();
    const twoMinutes = 2 * 60 * 1000;
    
    if (now - messageTime > twoMinutes) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '只能撤回 2 分钟内的消息' }));
      return;
    }
    
    // 撤回消息（软删除）
    await pool.query(
      'UPDATE messages SET is_deleted = TRUE, recalled_at = NOW() WHERE message_id = ?',
      [messageId]
    );
    
    // 广播撤回通知
    if (global.broadcastChatMessage) {
      const data = JSON.stringify({
        type: 'message-recalled',
        payload: {
          messageId,
          conversationId: message.conversation_id,
          recalledAt: new Date()
        }
      });
      
      // 直接广播给所有客户端
      // global.broadcastChatMessage 是一个函数，需要调用它
      global.broadcastChatMessage(message.conversation_id, {
        type: 'recalled',
        message_id: messageId,
        recalled_at: new Date()
      });
    }
    
    console.log(`[Chat] 消息已撤回: ${messageId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    
  } catch (e) {
    console.error('[Chat] 撤回消息失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '撤回消息失败' }));
  }
});

// ──────────────────────────────────────────────
// 图片上传功能
// ──────────────────────────────────────────────

server.on('request', async (req, res) => {
  if (req.url !== '/api/chat/upload' || req.method !== 'POST') return;
  
  try {
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
    
    // 使用 multer 处理上传
    upload.single('image')(req, res, async (err) => {
      if (err) {
        console.error('[Chat] 上传失败:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未找到图片文件' }));
        return;
      }
      
      try {
        // 生成唯一文件名
        const ext = req.file.originalname.split('.').pop();
        const filename = `chat-images/${generateId('img')}.${ext}`;
        
        // 上传到 COS
        const result = await new Promise((resolve, reject) => {
          cosClient.putObject({
            Bucket: COS_BUCKET,
            Region: COS_REGION,
            Key: filename,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
          }, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        
        // 生成访问 URL
        const url = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${filename}`;
        
        console.log(`[Chat] 图片上传成功: ${filename}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          url,
          filename: req.file.originalname,
          size: req.file.size
        }));
        
      } catch (e) {
        console.error('[Chat] COS 上传失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '上传失败' }));
      }
    });
    
  } catch (e) {
    console.error('[Chat] 上传处理失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '上传失败' }));
  }
});

// ──────────────────────────────────────────────
// 已读回执功能
// ──────────────────────────────────────────────

// 标记消息已读
server.on('request', async (req, res) => {
  if (!req.url.match(/\/api\/chat\/message\/[^/]+\/read$/) || req.method !== 'POST') return;
  
  try {
    const url = new URL(req.url, 'http://localhost');
    const messageId = url.pathname.split('/')[4];
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
    
    // 标记已读
    await pool.query(
      'INSERT INTO message_reads (message_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = NOW()',
      [messageId, userId]
    );
    
    // 获取消息信息（用于通知发送者）
    const [messages] = await pool.query(
      'SELECT conversation_id, sender_id FROM messages WHERE message_id = ?',
      [messageId]
    );
    
    if (messages.length > 0 && global.broadcastChatMessage) {
      // 通知发送者：对方已读
      global.broadcastChatMessage(messages[0].conversation_id, {
        type: 'message-read',
        message_id: messageId,
        user_id: userId,
        read_at: new Date()
      });
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    
  } catch (e) {
    console.error('[Chat] 标记已读失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '标记已读失败' }));
  }
});

// 获取消息已读列表
server.on('request', async (req, res) => {
  if (!req.url.match(/\/api\/chat\/message\/[^/]+\/reads$/) || req.method !== 'GET') return;
  
  try {
    const url = new URL(req.url, 'http://localhost');
    const messageId = url.pathname.split('/')[4];
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
    
    // 获取已读列表
    const [reads] = await pool.query(`
      SELECT mr.*, u.username
      FROM message_reads mr
      LEFT JOIN users u ON mr.user_id = u.user_id
      WHERE mr.message_id = ?
      ORDER BY mr.read_at
    `, [messageId]);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, reads }));
    
  } catch (e) {
    console.error('[Chat] 获取已读列表失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '获取已读列表失败' }));
  }
});

// ──────────────────────────────────────────────
// @ 提及功能
// ──────────────────────────────────────────────

// 获取我被 @ 的消息列表
server.on('request', async (req, res) => {
  if (req.url !== '/api/chat/mentions' || req.method !== 'GET') return;
  
  try {
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
    
    // 获取我被 @ 的消息
    const [mentions] = await pool.query(`
      SELECT mm.*, m.content, m.conversation_id, m.sender_id, m.created_at, u.username as sender_name, c.name as conversation_name
      FROM message_mentions mm
      JOIN messages m ON mm.message_id = m.message_id
      LEFT JOIN users u ON m.sender_id = u.user_id
      LEFT JOIN conversations c ON m.conversation_id = c.conversation_id
      WHERE mm.user_id = ? OR mm.mention_all = TRUE
      ORDER BY mm.created_at DESC
      LIMIT 50
    `, [userId]);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, mentions }));
    
  } catch (e) {
    console.error('[Chat] 获取 @ 列表失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '获取 @ 列表失败' }));
  }
});

module.exports = { registerChatRoutes };
