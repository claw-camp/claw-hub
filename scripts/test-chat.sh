#!/bin/bash

# 龙虾营地聊天系统测试脚本
# 模拟用户发送消息到 Agent 并接收回复的完整流程

HUB_URL="http://localhost:8889"
CAMP_KEY="test-key-001"

echo "🦞 龙虾营地聊天系统测试"
echo "================================"
echo ""

# 1. 创建会话
echo "📝 步骤 1: 创建会话"
CONV_RESPONSE=$(curl -s -X POST $HUB_URL/api/chat/conversation \
  -H "Content-Type: application/json" \
  -H "x-camp-key: $CAMP_KEY" \
  -d '{"type":"bot","botId":"bot_main"}')

echo "响应: $CONV_RESPONSE"
CONV_ID=$(echo $CONV_RESPONSE | jq -r '.conversation.conversation_id')
echo "会话 ID: $CONV_ID"
echo ""

# 2. 发送消息
echo "💬 步骤 2: 发送消息"
MSG_RESPONSE=$(curl -s -X POST $HUB_URL/api/chat/message \
  -H "Content-Type: application/json" \
  -H "x-camp-key: $CAMP_KEY" \
  -d "{\"conversationId\":\"$CONV_ID\",\"content\":\"你好，大龙虾！\"}")

echo "响应: $MSG_RESPONSE"
echo ""

# 3. 获取消息历史
echo "📜 步骤 3: 获取消息历史"
sleep 2  # 等待 Agent 回复
HISTORY=$(curl -s -X GET "$HUB_URL/api/chat/messages/$CONV_ID?limit=10" \
  -H "x-camp-key: $CAMP_KEY")

echo "消息历史:"
echo $HISTORY | jq '.messages[]'
echo ""

# 4. 检查 Agent 状态
echo "🤖 步骤 4: 检查 Agent 状态"
AGENTS=$(curl -s $HUB_URL/api/agents)
echo $AGENTS | jq '.[] | {id, name, status, botId}'
echo ""

echo "✅ 测试完成！"
