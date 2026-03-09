/**
 * 聊天事件增强补丁
 */

async function sendMsgAck(pool, conversationId, messageId, userId) {
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: "msg_ack",
      payload: {
        messageId,
        status: "delivered",
        deliveredAt: Date.now()
      }
    });
  }
}

async function sendMsgRead(pool, conversationId, messageId) {
  await pool.query(
    "UPDATE messages SET status = ?, read_at = NOW() WHERE message_id = ?",
    ["read", messageId]
  );
  
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: "msg_read",
      payload: { messageId }
    });
  }
}

function sendMsgThinking(conversationId, messageId) {
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: "msg_thinking",
      payload: {
        messageId,
        thinkingMs: 0
      }
    });
  }
}

async function sendMsgReply(pool, conversationId, reply) {
  const { messageId, model, inputTokens, outputTokens, thinkingMs } = reply;
  
  await pool.query(
    "UPDATE messages SET model = ?, input_tokens = ?, output_tokens = ?, thinking_ms = ?, status = ? WHERE message_id = ?",
    [model || null, inputTokens || 0, outputTokens || 0, thinkingMs || 0, "delivered", messageId]
  );
  
  if (global.broadcastChatEvent) {
    global.broadcastChatEvent(conversationId, {
      type: "msg_reply",
      payload: reply
    });
  }
}

async function getUnreadCount(pool, conversationId, userId) {
  const [rows] = await pool.query(
    "SELECT unread_count FROM conversation_unreads WHERE conversation_id = ? AND user_id = ?",
    [conversationId, userId]
  );
  return rows[0]?.unread_count || 0;
}

async function markConversationRead(pool, conversationId, userId) {
  await pool.query(
    "INSERT INTO conversation_unreads (conversation_id, user_id, unread_count, last_read_at) VALUES (?, ?, 0, NOW()) ON DUPLICATE KEY UPDATE unread_count = 0, last_read_at = NOW()",
    [conversationId, userId]
  );
}

module.exports = {
  sendMsgAck,
  sendMsgRead,
  sendMsgThinking,
  sendMsgReply,
  getUnreadCount,
  markConversationRead
};
