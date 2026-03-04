/**
 * 解析 OpenClaw session .jsonl 文件，提取精确的 token 使用数据
 * 
 * 用法: node parse-usage.js [sessions目录] [小时数]
 * 输出: 按半小时槽聚合的 token 消耗
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = process.argv[2] || path.join(os.homedir(), '.openclaw/agents/main/sessions');
const HOURS = parseInt(process.argv[3]) || 6;

function parseSessions() {
  const cutoff = Date.now() - HOURS * 3600 * 1000;
  const usage = []; // { timestamp, input, output, session, model }

  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));

  for (const file of files) {
    const sessionId = file.replace('.jsonl', '');
    const filePath = path.join(SESSIONS_DIR, file);
    
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          
          // 只处理 message 类型且有 usage 的记录
          if (record.type === 'message' && record.message?.usage) {
            const ts = new Date(record.timestamp).getTime();
            if (ts >= cutoff) {
              usage.push({
                timestamp: ts,
                iso: record.timestamp,
                input: record.message.usage.input || 0,
                output: record.message.usage.output || 0,
                cacheRead: record.message.usage.cacheRead || 0,
                total: record.message.usage.totalTokens || 0,
                session: sessionId,
                model: record.message.model || 'unknown'
              });
            }
          }
        } catch (e) {
          // 跳过解析失败的行
        }
      }
    } catch (e) {
      // 跳过无法读取的文件
    }
  }

  return usage.sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateBySlot(usage) {
  const slots = {};
  
  for (const u of usage) {
    const d = new Date(u.timestamp);
    const hour = d.getHours().toString().padStart(2, '0');
    const minute = d.getMinutes() < 30 ? '00' : '30';
    const slot = `${hour}:${minute}`;
    
    if (!slots[slot]) {
      slots[slot] = { slot, input: 0, output: 0, cacheRead: 0, total: 0, count: 0, sessions: new Set() };
    }
    
    slots[slot].input += u.input;
    slots[slot].output += u.output;
    slots[slot].cacheRead += u.cacheRead;
    slots[slot].total += u.total;
    slots[slot].count += 1;
    slots[slot].sessions.add(u.session);
  }
  
  // 转换为数组并格式化
  return Object.values(slots)
    .map(s => ({
      ...s,
      sessions: s.sessions.size
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

// 主函数
function main() {
  console.error(`解析目录: ${SESSIONS_DIR}`);
  console.error(`时间范围: 最近 ${HOURS} 小时\n`);
  
  const usage = parseSessions();
  console.error(`找到 ${usage.length} 条消息记录\n`);
  
  const slots = aggregateBySlot(usage);
  
  console.log('=== 按半小时槽聚合 ===');
  console.log(JSON.stringify(slots, null, 2));
  
  console.log('\n=== 汇总 ===');
  const total = slots.reduce((acc, s) => ({
    input: acc.input + s.input,
    output: acc.output + s.output,
    cacheRead: acc.cacheRead + s.cacheRead
  }), { input: 0, output: 0, cacheRead: 0 });
  
  console.log(`输入 tokens: ${total.input.toLocaleString()}`);
  console.log(`输出 tokens: ${total.output.toLocaleString()}`);
  console.log(`缓存命中: ${total.cacheRead.toLocaleString()}`);
  console.log(`实际消耗: ${(total.input + total.output - total.cacheRead).toLocaleString()}`);
}

main();
