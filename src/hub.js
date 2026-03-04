/**
 * Claw Hub - 龙虾营地 Hub 服务端
 * 支持：WebSocket 实时推送 + MySQL 持久化 + 远程更新
 */

const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.CLAW_HUB_PORT || 8889;
const VERSION = require('../package.json').version;
const GIT_REPO = 'https://github.com/PhosAQy/claw-hub';
const UPDATE_TOKEN = process.env.CLAW_UPDATE_TOKEN || 'claw-hub-2026';

// 数据库配置 - 从环境变量读取
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'claw_camp',
  waitForConnections: true,
  connectionLimit: 5,
  timezone: '+08:00',
  connectTimeout: 5000
};

if (!DB_CONFIG.password) {
  console.error('[DB] ⚠️ 未设置数据库密码，请配置环境变量 DB_PASSWORD');
}

let pool = null;

async function initDB() {
  try {
    pool = mysql.createPool(DB_CONFIG);

    /**
     * session_snapshots：每个 session 每次活动状态的快照
     * 
     * session_key:         session 的唯一标识
     * session_updated_at:  该 session 真正发生活动的时间戳（来自 OpenClaw 的 updatedAt）
     * total_tokens:        该时刻的累计 token 数（单调递增）
     * 
     * UNIQUE(session_key, session_updated_at) 保证同一活动不重复写入
     * 后续通过相邻快照的 total_tokens 差值，得到该时间段的 token 增量
     */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        agent_id VARCHAR(100) NOT NULL,
        agent_name VARCHAR(100),
        session_key VARCHAR(255) NOT NULL,
        kind VARCHAR(50),
        model VARCHAR(100),
        total_tokens INT DEFAULT 0,
        session_updated_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_session_ts (session_key, session_updated_at),
        INDEX idx_agent (agent_id),
        INDEX idx_updated (session_updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 创建 token_usage 表
    await createTables();

    console.log('[DB] ✅ 初始化成功');
  } catch (e) {
    console.error('[DB] ❌ 初始化失败:', e.message);
    pool = null;
  }
}

/**
 * 创建 token_usage 表（存储精确的 token 使用数据）
 */
async function createTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        agent_id VARCHAR(100) NOT NULL,
        agent_name VARCHAR(100),
        date DATE NOT NULL,
        time_slot VARCHAR(5) NOT NULL,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        cache_read BIGINT DEFAULT 0,
        net_tokens BIGINT DEFAULT 0,
        message_count INT DEFAULT 0,
        updated_at BIGINT,
        UNIQUE KEY uk_agent_slot (agent_id, date, time_slot),
        INDEX idx_date (date),
        INDEX idx_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.error('[DB] 创建表失败:', e.message);
  }
}

/**
 * 存储 session 快照
 * 以 session 自己的 updatedAt 作为时间戳
 */
async function saveSnapshots(agentId, agentName, sessions) {
  if (!pool || !sessions?.list?.length) return;
  try {
    for (const s of sessions.list) {
      if (!s.updatedAt || !s.key) continue;
      // INSERT IGNORE 保证同一 (session_key, session_updated_at) 只写一次
      await pool.query(
        `INSERT IGNORE INTO session_snapshots
         (agent_id, agent_name, session_key, kind, model, total_tokens, session_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [agentId, agentName, s.key, s.kind || 'direct', s.model || '', s.tokens || 0, s.updatedAt]
      );
    }
  } catch (e) {
    console.error('[DB] 写入失败:', e.message);
  }
}

/**
 * 存储 token 使用数据（从 Agent 上报的精确数据）
 */
async function saveTokenUsage(agentId, agentName, tokenUsage) {
  if (!pool || !tokenUsage?.length) return;
  try {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    
    for (const slot of tokenUsage) {
      // 用 date + slot 作为唯一标识
      const slotId = `${today}:${slot.slot}`;
      await pool.query(
        `INSERT INTO token_usage 
         (agent_id, agent_name, date, time_slot, input_tokens, output_tokens, cache_read, net_tokens, message_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           input_tokens = VALUES(input_tokens),
           output_tokens = VALUES(output_tokens),
           cache_read = VALUES(cache_read),
           net_tokens = VALUES(net_tokens),
           message_count = VALUES(message_count),
           updated_at = VALUES(updated_at)`,
        [agentId, agentName, today, slot.slot, slot.input, slot.output, slot.cacheRead, slot.netTokens, slot.count, now]
      );
    }
  } catch (e) {
    console.error('[DB] 存储 token 使用失败:', e.message);
  }
}

/**
 * 查询 Token 消耗时间序列（使用精确数据）
 */
async function getTokenTimeSeries(agentId = null, hours = 6) {
  if (!pool) return [];
  try {
    const agentFilter = agentId ? 'AND agent_id = ?' : '';
    const params = agentId ? [hours, agentId] : [hours];
    
    // 从 token_usage 表查询
    const [rows] = await pool.query(`
      SELECT 
        agent_id,
        agent_name,
        time_slot,
        SUM(input_tokens) as input,
        SUM(output_tokens) as output,
        SUM(cache_read) as cacheRead,
        SUM(net_tokens) as netTokens,
        SUM(message_count) as count
      FROM token_usage
      WHERE updated_at > UNIX_TIMESTAMP(NOW() - INTERVAL ? HOUR) * 1000
        ${agentFilter}
      GROUP BY agent_id, agent_name, time_slot
      ORDER BY time_slot ASC
    `, params);
    
    return rows.map(r => ({
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      time_slot: r.time_slot,
      input: r.input,
      output: r.output,
      cacheRead: r.cacheRead,
      tokens: r.netTokens,  // 实际消耗
      count: r.count
    }));
  } catch (e) {
    console.error('[DB] 查询时序失败:', e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// Agent 状态管理
// ──────────────────────────────────────────────

const agents = new Map();
const clients = new Set();

// ──────────────────────────────────────────────
// 版本管理和更新
// ──────────────────────────────────────────────

/**
 * 获取 GitHub 最新版本
 */
async function getLatestVersion() {
  return new Promise((resolve, reject) => {
    exec('git ls-remote --tags origin', { timeout: 10000 }, (err, stdout) => {
      if (err) {
        // 无法访问远程，返回当前版本
        resolve(VERSION);
        return;
      }
      // 解析 tags，找到最新版本
      const tags = stdout.split('\n')
        .filter(line => line.includes('refs/tags/'))
        .map(line => line.split('refs/tags/')[1])
        .filter(tag => tag && tag.startsWith('v'))
        .sort((a, b) => b.localeCompare(a));
      
      resolve(tags[0] ? tags[0].replace('v', '') : VERSION);
    });
  });
}

/**
 * 执行更新
 */
async function doUpdate() {
  const projectDir = path.join(__dirname, '..');
  
  return new Promise((resolve, reject) => {
    // git pull
    exec('git pull', { cwd: projectDir, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Git pull failed: ${stderr}`));
        return;
      }
      
      const pullResult = stdout.trim();
      
      // 检查是否有更新
      if (pullResult.includes('Already up to date')) {
        resolve({ 
          success: true, 
          updated: false, 
          message: 'Already up to date',
          version: VERSION 
        });
        return;
      }
      
      // 有更新，需要重启
      resolve({
        success: true,
        updated: true,
        message: pullResult,
        version: VERSION,
        needRestart: true
      });
      
      // 3秒后重启（给响应时间）
      setTimeout(() => {
        console.log('[Hub] 更新完成，正在重启...');
        process.exit(0);  // 退出，由进程管理器重启
      }, 3000);
    });
  });
}

const server = http.createServer((req, res) => {
  const allowedOrigins = ['https://camp.aigc.sx.cn', 'http://localhost:8889'];
  const origin = req.headers.origin || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : '';

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 版本信息
  if (req.url === '/api/version') {
    getLatestVersion().then(latest => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: VERSION,
        latest: latest,
        hasUpdate: latest && latest !== VERSION,
        repo: GIT_REPO
      }));
    }).catch(e => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: VERSION, latest: VERSION, hasUpdate: false, repo: GIT_REPO }));
    });
    return;
  }

  // 获取更新令牌（用于前端调用更新 API）
  if (req.url === '/api/token') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: UPDATE_TOKEN }));
    return;
  }

  // 检查更新
  if (req.url === '/api/check-update') {
    getLatestVersion().then(latest => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        current: VERSION,
        latest: latest,
        hasUpdate: latest && latest !== VERSION
      }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // 执行更新（需要 token）
  if (req.url.startsWith('/api/update')) {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    
    if (token !== UPDATE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }
    
    doUpdate().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: getAgentList() }, null, 2));
    return;
  }

  // 前端拉时序数据用于绘图
  if (req.url.startsWith('/api/history')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || null;
    const hours = parseInt(url.searchParams.get('hours') || '6');
    getTokenTimeSeries(agentId, hours).then(data => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history: data }));
    });
    return;
  }

  // 检查 Agent 是否需要更新
  if (req.url.startsWith('/api/agent/check-update')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    
    const agent = agents.get(agentId);
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found' }));
      return;
    }
    
    // 获取最新版本
    getLatestVersion().then(latest => {
      const current = agent.agentVersion || '0.0.0';
      const hasUpdate = latest > current;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agentId,
        currentVersion: current,
        latestVersion: latest,
        hasUpdate,
        repo: GIT_REPO
      }));
    });
    return;
  }

  // 触发 Agent 更新
  if (req.url.startsWith('/api/agent/update')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    const token = url.searchParams.get('token');
    
    // 验证 token
    if (token !== UPDATE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent || !agent.ws) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found or offline' }));
      return;
    }
    
    // 发送更新命令到 Agent
    agent.ws.send(JSON.stringify({ type: 'update', payload: { token } }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Update command sent' }));
    return;
  }

  // Gateway 启动
  if (req.url.startsWith('/api/gateway/start')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    const token = url.searchParams.get('token');
    
    // 验证 token
    if (token !== UPDATE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent || !agent.ws) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found or offline' }));
      return;
    }
    
    // 发送启动命令到 Agent
    agent.ws.send(JSON.stringify({ type: 'gateway-start', payload: { token } }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Gateway start command sent' }));
    return;
  }

  // Gateway 停止
  if (req.url.startsWith('/api/gateway/stop')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    const token = url.searchParams.get('token');
    
    // 验证 token
    if (token !== UPDATE_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid token' }));
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent || !agent.ws) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found or offline' }));
      return;
    }
    
    // 发送停止命令到 Agent
    agent.ws.send(JSON.stringify({ type: 'gateway-stop', payload: { token } }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Gateway stop command sent' }));
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let isAgent = false, agentId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe') {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'agents', payload: getAgentList() }));
        return;
      }
      isAgent = true;
      handleMessage(ws, msg, id => { agentId = id; });
    } catch (e) { console.error('[Hub] 解析失败:', e.message); }
  });

  ws.on('close', () => {
    if (isAgent && agentId && agents.has(agentId)) {
      const agent = agents.get(agentId);
      agent.status = 'offline';
      agent.lastSeen = Date.now();
      console.log(`[Hub] Agent 离线: ${agent.name}`);
      broadcastToClients();
    } else {
      clients.delete(ws);
    }
  });

  ws.on('error', err => console.error('[Hub] WS 错误:', err.message));
});

function handleMessage(ws, msg, setAgentId) {
  const { type, payload } = msg;
  switch (type) {
    case 'register': {
      const agent = {
        id: payload.id,
        name: payload.name || payload.id,
        host: payload.host,
        agentVersion: payload.agentVersion,  // Agent 版本
        status: 'online',
        lastSeen: Date.now(),
        gateway: null,
        sessions: [],
        stats: null,
        ws  // 保存 WebSocket 连接
      };
      agents.set(payload.id, agent);
      setAgentId(payload.id);
      console.log(`[Hub] Agent 注册: ${agent.name} @ ${agent.host} (v${payload.agentVersion || 'N/A'})`);
      ws.send(JSON.stringify({ type: 'registered', payload: { id: payload.id } }));
      broadcastToClients();
      break;
    }
    case 'heartbeat':
      if (agents.has(payload.id)) {
        const a = agents.get(payload.id);
        a.lastSeen = Date.now(); a.status = 'online';
      }
      break;
    case 'status':
      if (agents.has(payload.id)) {
        const agent = agents.get(payload.id);
        agent.lastSeen = Date.now();
        agent.gateway = payload.gateway;
        agent.sessions = payload.sessions || [];
        agent.stats = payload.stats;
        agent.plugins = payload.plugins || [];  // 保存插件列表
        agent.agentVersion = payload.agentVersion;  // 保存 Agent 版本
        
        // 异步存库
        saveSnapshots(payload.id, agent.name, payload.sessions);
        // 存储精确的 token 使用数据
        if (payload.tokenUsage) {
          saveTokenUsage(payload.id, agent.name, payload.tokenUsage);
        }
        broadcastToClients();
      }
      break;
    
    case 'update-result':
      // Agent 更新结果
      console.log(`[Hub] Agent ${payload.id} 更新结果:`, payload);
      break;
  }
}

function broadcastToClients() {
  const data = JSON.stringify({ type: 'agents', payload: getAgentList() });
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function getAgentList() {
  return Array.from(agents.values()).map(a => {
    const { ws, ...agentData } = a;  // 排除 ws 字段
    return {
      ...agentData,
      plugins: a.plugins || []
    };
  });
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  agents.forEach(agent => {
    if (agent.status === 'online' && now - agent.lastSeen > 30000) {
      agent.status = 'offline';
      changed = true;
    }
  });
  if (changed) broadcastToClients();
}, 10000);

async function start() {
  await initDB();
  server.listen(PORT, () => {
    console.log(`🦞 龙虾营地 Hub`);
    console.log(`   WebSocket: ws://localhost:${PORT}`);
    console.log(`   API:       http://localhost:${PORT}/api/agents`);
    console.log(`   History:   http://localhost:${PORT}/api/history?hours=6&agent=main`);
  });
}

start();
