/**
 * Claw Agent - 本地监控 Agent
 * 
 * 功能：
 * - 连接到 Hub
 * - 采集 Gateway 状态
 * - 采集会话列表
 * - 采集系统资源
 * - 解析 session .jsonl 获取精确 token 使用（按半小时槽聚合）
 * - 定时上报
 * 
 * @name 龙虾营地 Agent
 * @version 1.0.0
 */

const WebSocket = require('ws');
const { execSync, exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Agent 信息
const AGENT_NAME = '龙虾营地 Agent';
const AGENT_VERSION = '1.10.1';
const GITHUB_REPO = 'https://github.com/PhosAQy/claw-hub';

// 配置
const CONFIG = {
  hubUrl: process.env.CLAW_HUB_URL || 'ws://server.aigc.sx.cn:8889',
  agentId: process.env.CLAW_AGENT_ID || 'main',
  agentName: process.env.CLAW_AGENT_NAME || '大龙虾',
  reportInterval: 5000,  // 上报间隔
  gatewayPort: 18789,    // Gateway 端口
  gatewayToken: process.env.CLAW_GATEWAY_TOKEN || '',  // Gateway Token (从环境变量读取)
  // sessions 目录：优先使用环境变量，否则根据 sessionsAgentId 或 agentId 计算
  get sessionsDir() {
    if (process.env.CLAW_SESSIONS_DIR) return process.env.CLAW_SESSIONS_DIR;
    const sessionsAgentId = process.env.CLAW_SESSIONS_AGENT_ID || this.agentId;
    return path.join(os.homedir(), '.openclaw/agents', sessionsAgentId, 'sessions');
  },
  updateToken: process.env.CLAW_UPDATE_TOKEN || ''  // 更新令牌
};

let ws = null;
let reconnectTimer = null;

// 获取主机名
function getHostname() {
  return os.hostname();
}

// 检查 Gateway 状态
function getGatewayStatus() {
  try {
    const result = execSync(`ps aux | grep -v grep | grep -c "openclaw-gateway"`, {
      encoding: 'utf-8',
      timeout: 3000
    }).trim();
    const isRunning = parseInt(result) > 0;
    return { status: isRunning ? 'running' : 'stopped', port: CONFIG.gatewayPort };
  } catch (e) {
    return { status: 'stopped', port: CONFIG.gatewayPort };
  }
}

// 获取会话列表（用于显示）
function getSessions() {
  try {
    const result = execSync('openclaw sessions --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000
    });
    const data = JSON.parse(result);
    const sessions = data.sessions || [];
    
    const recentSessions = sessions
      .filter(s => s.ageMs < 24 * 60 * 60 * 1000)
      .slice(0, 50)
      .map(s => ({
        key: s.key,
        kind: s.kind || 'direct',
        model: s.model,
        tokens: s.totalTokens,
        inputTokens: s.inputTokens || 0,
        outputTokens: s.outputTokens || 0,
        updatedAt: s.updatedAt,
        age: Math.round((s.ageMs || 0) / 60000) + '分钟前'
      }));
    
    return {
      count: sessions.length,
      todayActive: sessions.filter(s => s.ageMs < 24 * 60 * 60 * 1000).length,
      list: recentSessions
    };
  } catch (e) {
    return { count: 0, todayActive: 0, list: [] };
  }
}

/**
 * 解析 session .jsonl 文件，获取精确的 token 使用数据
 * 按半小时槽聚合
 * 自动扫描所有 agents 的 sessions 目录
 */
function getTokenUsage(hours = 6) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const slots = {};

  // 获取所有 sessions 目录
  const agentsDir = path.join(os.homedir(), '.openclaw/agents');
  let sessionsDirs = [];
  
  try {
    // 优先使用配置的目录
    if (process.env.CLAW_SESSIONS_DIR) {
      sessionsDirs = [process.env.CLAW_SESSIONS_DIR];
    } else if (process.env.CLAW_SESSIONS_AGENT_ID) {
      sessionsDirs = [path.join(agentsDir, process.env.CLAW_SESSIONS_AGENT_ID, 'sessions')];
    } else {
      // 自动扫描所有 agents 的 sessions 目录
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(agentsDir, d.name, 'sessions'));
      sessionsDirs = agents;
    }
  } catch (e) {
    // 使用默认目录
    sessionsDirs = [CONFIG.sessionsDir];
  }

  for (const sessionsDir of sessionsDirs) {
    try {
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));

      for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(Boolean);
          
          for (const line of lines) {
            try {
              const record = JSON.parse(line);
              
              if (record.type === 'message' && record.message?.usage) {
                const ts = new Date(record.timestamp).getTime();
                if (ts >= cutoff) {
                  // 计算半小时槽
                  const d = new Date(ts);
                  const hour = d.getHours().toString().padStart(2, '0');
                  const minute = d.getMinutes() < 30 ? '00' : '30';
                  const slot = `${hour}:${minute}`;
                  
                  if (!slots[slot]) {
                    slots[slot] = { slot, input: 0, output: 0, cacheRead: 0, count: 0 };
                  }
                  
                  const usage = record.message.usage;
                  slots[slot].input += usage.input || 0;
                  slots[slot].output += usage.output || 0;
                  slots[slot].cacheRead += usage.cacheRead || 0;
                  slots[slot].count += 1;
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
    } catch (e) {
      // 目录不存在或无权限
    }
  }

  // 转换为数组
  return Object.values(slots)
    .map(s => ({
      ...s,
      // 总消耗 = 输入 + 输出（缓存命中是优化指标，不影响实际消耗）
      netTokens: s.input + s.output,
      totalTokens: s.input + s.output + s.cacheRead  // 含缓存的总量
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

// 获取系统资源
function getSystemStats() {
  try {
    let cpu = 0;
    const cpuInfo = execSync('top -l 1 -n 0 | grep "CPU usage" 2>/dev/null || echo ""', {
      encoding: 'utf-8',
      timeout: 3000
    });
    const cpuMatch = cpuInfo.match(/(\d+\.?\d*)\s*%/);
    if (cpuMatch) cpu = parseFloat(cpuMatch[1]);
    
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memory = Math.round((1 - freeMem / totalMem) * 100);
    
    // 从精确数据计算今日 token（含 cacheRead）
    const tokenUsage = getTokenUsage(24);
    const todayNetTokens = tokenUsage.reduce((sum, s) => sum + s.netTokens, 0);
    const todayCacheRead = tokenUsage.reduce((sum, s) => sum + s.cacheRead, 0);
    const todayTokens = todayNetTokens + todayCacheRead;  // 总处理量
    
    return { cpu, memory, todayTokens, todayNetTokens, todayCacheRead };
  } catch (e) {
    return { cpu: 0, memory: 0, todayTokens: 0, todayNetTokens: 0, todayCacheRead: 0 };
  }
}

// 获取已加载的插件列表
function getPlugins() {
  try {
    const result = execSync('openclaw plugins list 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10000
    });
    
    // 解析表格格式
    const plugins = [];
    const lines = result.split('\n');
    let inTable = false;
    
    for (const line of lines) {
      // 检测表格开始（包含表头分隔符）
      if (line.includes('─') && line.includes('┼')) {
        inTable = true;
        continue;
      }
      
      // 检测表格结束
      if (inTable && line.includes('└')) {
        break;
      }
      
      // 解析表格行（只处理包含 loaded 的行）
      if (inTable && line.includes('│') && line.includes('loaded')) {
        const cols = line.split('│').map(c => c.trim()).filter(c => c);
        if (cols.length >= 4) {
          const [name, id, status, source, version] = cols;
          
          // 从 source 推断完整名称
          let fullName = name || id;
          if (source.includes('device-pair')) {
            fullName = 'Device Pairing';
          } else if (source.includes('feishu-card')) {
            fullName = 'Feishu Interactive Card';
          } else if (source.includes('feishu/index')) {
            fullName = 'Feishu';
          } else if (source.includes('memory-core')) {
            fullName = 'Memory (Core)';
          } else if (source.includes('phone-control')) {
            fullName = 'Phone Control';
          } else if (source.includes('talk-voice')) {
            fullName = 'Talk Voice';
          }
          
          plugins.push({
            name: fullName,
            id: id || 'unknown',
            version: version || 'unknown',
            source: source || ''
          });
        }
      }
    }
    
    return plugins;
  } catch (e) {
    return [];
  }
}

// ──────────────────────────────────────────────
// 版本管理和更新
// ──────────────────────────────────────────────

/**
 * 语义化版本比较
 * 返回: 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 获取最新版本（从 GitHub tags）
 */
async function getLatestVersion() {
  return new Promise((resolve) => {
    exec('git ls-remote --tags origin', { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve(AGENT_VERSION);
        return;
      }
      
      const tags = stdout.split('\n')
        .filter(line => line.includes('refs/tags/'))
        .map(line => line.split('refs/tags/')[1])
        .filter(tag => tag && tag.startsWith('v'))
        .sort((a, b) => compareVersions(b, a));  // 语义化版本比较
      
      resolve(tags[0] ? tags[0].replace('v', '') : AGENT_VERSION);
    });
  });
}

/**
 * 执行更新
 */
async function doUpdate() {
  return new Promise((resolve) => {
    const projectDir = path.join(__dirname, '..');
    
    exec('git pull', { cwd: projectDir, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message });
        return;
      }
      
      const updated = !stdout.includes('Already up to date');
      
      if (updated) {
        console.log('[Agent] 更新成功，即将重启...');
        
        // 发送成功响应后再重启
        resolve({
          success: true,
          updated: true,
          message: '更新成功，即将重启',
          version: AGENT_VERSION
        });
        
        // 延迟后自己重启（不依赖 pm2）
        setTimeout(() => {
          const child = spawn(process.execPath, [path.join(projectDir, 'src/agent.js')], {
            detached: true,
            stdio: 'inherit',
            env: process.env
          });
          child.unref();
          process.exit(0);
        }, 1500);
        return;
      }
      
      resolve({
        success: true,
        updated: false,
        message: '已是最新版本',
        version: AGENT_VERSION
      });
    });
  });
}

// 发送消息
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 上报状态
function reportStatus() {
  const gateway = getGatewayStatus();
  const sessions = getSessions();
  const stats = getSystemStats();
  const tokenUsage = getTokenUsage(6);  // 最近 6 小时
  const plugins = getPlugins();  // 获取插件列表
  
  send({
    type: 'status',
    payload: {
      id: CONFIG.agentId,
      host: getHostname(),  // 每次上报主机名
      agentVersion: AGENT_VERSION,  // Agent 版本
      gateway,
      sessions,
      stats,
      tokenUsage,  // 精确的 token 使用数据
      plugins      // 新增：插件列表
    }
  });
}

// 连接到 Hub
function connect() {
  console.log(`[Agent] 连接 Hub: ${CONFIG.hubUrl}`);
  
  ws = new WebSocket(CONFIG.hubUrl);
  
  ws.on('open', () => {
    console.log('[Agent] 已连接到 Hub');
    
    send({
      type: 'register',
      payload: {
        id: CONFIG.agentId,
        name: CONFIG.agentName,
        host: getHostname(),
        agentVersion: AGENT_VERSION  // Agent 版本
      }
    });
    
    clearInterval(reconnectTimer);
    reconnectTimer = setInterval(() => {
      send({ type: 'heartbeat', payload: { id: CONFIG.agentId } });
      reportStatus();
    }, CONFIG.reportInterval);
    
    setTimeout(reportStatus, 1000);
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') {
        console.log(`[Agent] 注册成功: ${msg.payload.id}`);
      } else if (msg.type === 'update') {
        // 收到更新命令
        console.log('[Agent] 收到更新命令');
        handleUpdate(msg.payload?.token);
      }
    } catch (e) {
      console.error('[Agent] 解析消息失败:', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log('[Agent] 连接断开，5秒后重连...');
    clearInterval(reconnectTimer);
    setTimeout(connect, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('[Agent] 连接错误:', err.message);
  });
}

// 处理更新
async function handleUpdate(token) {
  // 验证 token（可选）
  if (CONFIG.updateToken && token !== CONFIG.updateToken) {
    console.log('[Agent] 更新令牌无效');
    send({ type: 'update-result', payload: { success: false, error: 'Invalid token' } });
    return;
  }
  
  const result = await doUpdate();
  send({ type: 'update-result', payload: result });
}

// 启动
console.log('');
console.log(`🦞 龙虾营地 Agent v${AGENT_VERSION}`);
console.log(`   Agent: ${CONFIG.agentName} (${CONFIG.agentId})`);
console.log(`   Hub: ${CONFIG.hubUrl}`);
console.log('');

connect();
