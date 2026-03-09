const fs = require('fs');
const path = require('path');

const filePath = path.join(process.env.HOME, 'claw-hub/src/chat-routes.js');
let content = fs.readFileSync(filePath, 'utf8');

// 替换：广播到所有 sockets -> 只发给第一个有效的 socket
const oldCode = `    // 广播到 Agent 的所有 WebSocket 连接（支持多 Gateway）
    if (targetAgent.sockets && targetAgent.sockets.size > 0) {
      targetAgent.sockets.forEach(ws => {
        if (ws.readyState === 1) ws.send(msgData);
      });
    } else if (targetAgent.ws && targetAgent.ws.readyState === 1) {
      targetAgent.ws.send(msgData);
    }`;

const newCode = `    // 只发给第一个有效的 WebSocket 连接（避免重复）
    let sent = false;
    if (targetAgent.sockets && targetAgent.sockets.size > 0) {
      for (const ws of targetAgent.sockets) {
        if (ws.readyState === 1 && !sent) {
          ws.send(msgData);
          sent = true;
          console.log(`[Chat] 消息已发送到 Agent ${targetAgent.id} 的一个连接`);
        }
      }
    } else if (targetAgent.ws && targetAgent.ws.readyState === 1) {
      targetAgent.ws.send(msgData);
      sent = true;
    }`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync(filePath, content);
  console.log('✅ 已修复：只发给第一个有效的 socket');
} else {
  console.log('❌ 未找到目标代码，可能已修改');
}
