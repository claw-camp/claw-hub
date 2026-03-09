/**
 * 聊天事件增强补丁
 * 添加: msg_ack, msg_read, msg_thinking, msg_reply 事件
 */

/**
 * 发送消息确认
 */
async function sendMsgAck(pool, conversationId, messageId, userId) {
  // 更新未读计数
  if (global.isUserOnline && !global.isUserOnline(userId)) {
    await pool.query(\`
      INSERT INTO conversation_unreads (conversation_id, user_id, unread_count)
      VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE unread_count = unread_count + 1
    \`, [conversationId, userId]);
  }
  
  // 广播 ack 事件
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, "msg_ack", {
      messageId,
      status: "delivered",
      deliveredAt: Date.now()
    });
  }
}

/**
 * 发送已读回执
 */
async function sendMsgRead(pool, conversationId, messageId) {
  await pool.query(
    "UPDATE messages SET status = ?, read_at = NOW() WHERE message_id = ?",
    ["read", messageId]
  );
  
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, "msg_read", { messageId });
  }
}

/**
 * 发送思考状态
 */
function sendMsgThinking(conversationId, messageId) {
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, "msg_thinking", {
      messageId,
      thinkingMs: 0  // 持续更新
    });
  }
}

/**
 * 发送回复（带完整元数据）
 */
async function sendMsgReply(pool, conversationId, reply) {
  const { messageId, model, inputTokens, outputTokens, thinkingMs } = reply;
  
  // 更新消息记录
  await pool.query(\`
    UPDATE messages SET 
      model = ?,
      input_tokens = ?,
      output_tokens = ?,
      thinking_ms = ?,
      status = "delivered"
    WHERE message_id = ?
  \`, [model || null, inputTokens || 0, outputTokens || 0, thinkingMs || 0, messageId]);
  
  // 广播完整回复
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, "msg_reply", reply);
  }
}

/**
 * 获取会话未读数
 */
async function getUnreadCount(pool, conversationId, userId) {
  const [rows] = await pool.query(\`
    SELECT unread_count FROM conversation_unreads
    WHERE conversation_id = ? AND user_id = ?
  \`, [conversationId, userId]);
  return rows[0]?.unread_count || 0;
}

/**
 * 标记已读
 */
async function markConversationRead(pool, conversationId, userId) {
  await pool.query(\`
    INSERT INTO conversation_unreads (conversation_id, user_id, unread_count, last_read_at)
    VALUES (?, ?, 0, NOW())
    ON DUPLICATE KEY UPDATE unread_count = 0, last_read_at = NOW()
  \`, [conversationId, userId]);
}

module.exports = {
  sendMsgAck,
  sendMsgRead,
  sendMsgThinking,
  sendMsgReply,
  getUnreadCount,
  markConversationRead
};
