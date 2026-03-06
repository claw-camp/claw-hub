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

// 加载 .env 文件（如果存在）
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

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

    // 创建用户表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) UNIQUE NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        camp_key VARCHAR(64) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        INDEX idx_user_id (user_id),
        INDEX idx_username (username),
        INDEX idx_camp_key (camp_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 创建 bots 表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bot_id VARCHAR(32) UNIQUE NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        avatar VARCHAR(255) DEFAULT '🦞',
        token VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        INDEX idx_bot_id (bot_id),
        INDEX idx_user_id (user_id),
        INDEX idx_token (token),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

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
const pendingRequests = new Map();  // 等待 Agent 响应的请求

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
      // 解析 tags，找到最新版本（语义化比较）
      const tags = stdout.split('\n')
        .filter(line => line.includes('refs/tags/'))
        .map(line => line.split('refs/tags/')[1])
        .filter(tag => tag && tag.startsWith('v'))
        .sort((a, b) => compareVersions(b, a));
      
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
    // 先 reset 清除本地改动，再 pull
    exec('git reset --hard HEAD && git clean -fd', { cwd: projectDir, timeout: 10000 }, () => {
      // 忽略 reset 错误，继续 pull
    });
    exec('git fetch origin && git reset --hard origin/main', { cwd: projectDir, timeout: 30000 }, (err, stdout, stderr) => {
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
        console.log('[Hub] 更新完成，部署前端文件...');
        exec('sudo cp /home/phosa_claw/claw-hub/src/frontend/index.html /var/www/camp/index.html', () => {
          console.log('[Hub] 前端文件已部署，正在重启...');
          process.exit(0);
        });
      }, 3000);
    });
  });
}

const server = http.createServer((req, res) => {
  const allowedOrigins = ['https://camp.aigc.sx.cn', 'http://localhost:8889'];
  const origin = req.headers.origin || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : '';

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 静态文件服务（Dashboard）
  if (req.method === 'GET' && !req.url.startsWith('/api/')) {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'frontend', filePath);
    
    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml'
    };
    
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

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
      const hasUpdate = compareVersions(latest, current) > 0;
      
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

  // 刷新状态
  if (req.url.startsWith('/api/gateway/refresh')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    
    const agent = agents.get(agentId);
    if (!agent || !agent.ws) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found or offline' }));
      return;
    }
    
    // 发送状态刷新请求到 Agent
    agent.ws.send(JSON.stringify({ type: 'status-request' }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Status refresh request sent' }));
    return;
  }

  // 获取会话历史
  if (req.url.startsWith('/api/session/history')) {
    const url = new URL(req.url, 'http://x');
    const agentId = url.searchParams.get('agent') || 'main';
    const sessionKey = url.searchParams.get('session');
    const limit = parseInt(url.searchParams.get('limit') || '100');
    
    if (!sessionKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session parameter' }));
      return;
    }
    
    const agent = agents.get(agentId);
    if (!agent || !agent.ws) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent not found or offline' }));
      return;
    }
    
    // 保存响应回调，等待 Agent 返回
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Timeout waiting for agent response' }));
    }, 10000);
    
    pendingRequests.set(requestId, { res, timeout });
    
    // 发送请求到 Agent
    agent.ws.send(JSON.stringify({
      type: 'session-history',
      payload: { sessionKey, limit, requestId }
    }));
    return;
  }

  // ──────────────────────────────────────────────
  // 用户认证 API
  // ──────────────────────────────────────────────

  // 用户注册
  if (req.url === '/api/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { username, password, email } = JSON.parse(body);
        
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名和密码不能为空' }));
          return;
        }
        
        // 检查用户名是否已存在
        const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名已存在' }));
          return;
        }
        
        // 生成密码哈希（简单版，生产环境应该用 bcrypt）
        const crypto = require('crypto');
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        
        // 生成 camp_key
        const campKey = crypto.randomBytes(32).toString('hex');
        
        // 生成 user_id: uid_<16位数字小写字母>
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let randomStr = '';
        for (let i = 0; i < 16; i++) {
          randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const userId = `uid_${randomStr}`;
        
        // 插入用户
        await pool.query(
          'INSERT INTO users (user_id, username, password_hash, email, camp_key) VALUES (?, ?, ?, ?, ?)',
          [userId, username, passwordHash, email || null, campKey]
        );
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: '注册成功',
          userId,
          campKey 
        }));
      } catch (e) {
        console.error('[Auth] 注册失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '注册失败' }));
      }
    });
    return;
  }

  // 用户登录
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        
        if (!username || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名和密码不能为空' }));
          return;
        }
        
        // 查询用户
        const [users] = await pool.query(
          'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
          [username]
        );
        
        if (users.length === 0) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名或密码错误' }));
          return;
        }
        
        const user = users[0];
        
        // 验证密码
        const crypto = require('crypto');
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        
        if (user.password_hash !== passwordHash) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名或密码错误' }));
          return;
        }
        
        // 更新最后登录时间
        await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: '登录成功',
          user: {
            id: user.id,
            userId: user.user_id,
            username: user.username,
            email: user.email,
            campKey: user.camp_key
          }
        }));
      } catch (e) {
        console.error('[Auth] 登录失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '登录失败' }));
      }
    });
    return;
  }

  // 重新生成 camp_key
  if (req.url === '/api/regenerate-key' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        
        // 验证用户
        const [users] = await pool.query(
          'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
          [username]
        );
        
        if (users.length === 0) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名或密码错误' }));
          return;
        }
        
        const user = users[0];
        const crypto = require('crypto');
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        
        if (user.password_hash !== passwordHash) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户名或密码错误' }));
          return;
        }
        
        // 生成新的 camp_key
        const newCampKey = crypto.randomBytes(32).toString('hex');
        
        // 更新数据库
        await pool.query('UPDATE users SET camp_key = ? WHERE id = ?', [newCampKey, user.id]);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Key 已重新生成',
          campKey: newCampKey
        }));
      } catch (e) {
        console.error('[Auth] 重新生成 key 失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '重新生成 key 失败' }));
      }
    });
    return;
  }

  // ──────────────────────────────────────────────
  // Bot 管理 API
  // ──────────────────────────────────────────────

  // 创建 Bot
  if (req.url === '/api/bot/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { userId, name, description } = JSON.parse(body);
        
        if (!userId || !name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户ID和Bot名称不能为空' }));
          return;
        }
        
        // 验证用户是否存在
        const [users] = await pool.query('SELECT * FROM users WHERE user_id = ? AND is_active = TRUE', [userId]);
        if (users.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '用户不存在' }));
          return;
        }
        
        const crypto = require('crypto');
        
        // 生成 bot_id: bot_<16位>
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let randomStr = '';
        for (let i = 0; i < 16; i++) {
          randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const botId = `bot_${randomStr}`;
        
        // 生成 bot token
        const botToken = crypto.randomBytes(32).toString('hex');
        
        // 插入 bot
        await pool.query(
          'INSERT INTO bots (bot_id, user_id, name, description, token) VALUES (?, ?, ?, ?, ?)',
          [botId, userId, name, description || null, botToken]
        );
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Bot 创建成功',
          bot: {
            botId,
            name,
            description,
            token: botToken
          }
        }));
      } catch (e) {
        console.error('[Bot] 创建失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '创建 Bot 失败' }));
      }
    });
    return;
  }

  // 列出用户的 Bots
  if (req.url.startsWith('/api/bot/list') && req.method === 'GET') {
    (async () => {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const userId = urlParams.searchParams.get('userId');
      
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '用户ID不能为空' }));
        return;
      }
      
      try {
        const [bots] = await pool.query(
          'SELECT bot_id, name, description, avatar, created_at, is_active FROM bots WHERE user_id = ? AND is_active = TRUE ORDER BY created_at DESC',
          [userId]
        );
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          bots 
        }));
      } catch (e) {
        console.error('[Bot] 查询失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '查询 Bot 失败' }));
      }
    })();
    return;
  }

  // 获取 Bot 详情（包含 token）
  if (req.url.startsWith('/api/bot/detail') && req.method === 'GET') {
    (async () => {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const botId = urlParams.searchParams.get('botId');
      const userId = urlParams.searchParams.get('userId');
      
      if (!botId || !userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bot ID 和用户ID不能为空' }));
        return;
      }
      
      try {
        const [bots] = await pool.query(
          'SELECT * FROM bots WHERE bot_id = ? AND user_id = ? AND is_active = TRUE',
          [botId, userId]
        );
        
        if (bots.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot 不存在' }));
          return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          bot: bots[0]
        }));
      } catch (e) {
        console.error('[Bot] 查询详情失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '查询 Bot 详情失败' }));
      }
    })();
    return;
  }

  // 删除 Bot（软删除）
  if (req.url === '/api/bot/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { botId, userId } = JSON.parse(body);
        
        if (!botId || !userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot ID 和用户ID不能为空' }));
          return;
        }
        
        // 软删除
        const [result] = await pool.query(
          'UPDATE bots SET is_active = FALSE WHERE bot_id = ? AND user_id = ?',
          [botId, userId]
        );
        
        if (result.affectedRows === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot 不存在' }));
          return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Bot 已删除'
        }));
      } catch (e) {
        console.error('[Bot] 删除失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '删除 Bot 失败' }));
      }
    });
    return;
  }

  // 重新生成 Bot Token
  if (req.url === '/api/bot/regenerate-token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { botId, userId } = JSON.parse(body);
        
        if (!botId || !userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot ID 和用户ID不能为空' }));
          return;
        }
        
        const crypto = require('crypto');
        const newToken = crypto.randomBytes(32).toString('hex');
        
        const [result] = await pool.query(
          'UPDATE bots SET token = ? WHERE bot_id = ? AND user_id = ? AND is_active = TRUE',
          [newToken, botId, userId]
        );
        
        if (result.affectedRows === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot 不存在' }));
          return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Token 已重新生成',
          token: newToken
        }));
      } catch (e) {
        console.error('[Bot] 重新生成 token 失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '重新生成 Token 失败' }));
      }
    });
    return;
  }

  // GET /api/bot/status?botId=xxx — 检查 bot 是否有 agent 在线
  if (req.url.startsWith('/api/bot/status') && req.method === 'GET') {
    (async () => {
      const url = new URL(req.url, 'http://localhost');
      const botId = url.searchParams.get('botId');
      const campKey = req.headers['x-camp-key'];

      if (!botId || !campKey) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'missing botId or auth' })); return;
      }

      // 验证用户身份
      const [users] = await pool.execute('SELECT id FROM users WHERE camp_key = ? AND is_active = 1', [campKey]);
      if (!users.length) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
      }
      const userId = users[0].id;

      // 验证该 bot 属于该用户
      const [bots] = await pool.execute(
        'SELECT bot_id, name FROM bots WHERE bot_id = ? AND user_id = ? AND is_active = 1',
        [botId, userId]
      );
      if (!bots.length) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'bot not found' })); return;
      }

      // 查找是否有该 bot 的 agent 在线
      let connectedAgent = null;
      for (const [, agent] of agents) {
        if (agent.botId === botId && agent.status === 'online') {
          connectedAgent = {
            id: agent.id,
            name: agent.name,
            host: agent.host,
            agentVersion: agent.agentVersion,
            status: agent.status,
            lastSeen: agent.lastSeen,
            sessions: agent.sessions || [],
            stats: agent.stats
          };
          break;
        }
      }

      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({
        connected: !!connectedAgent,
        agent: connectedAgent
      }));
    })();
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let isAgent = false, agentId = null;

  // 解析连接时携带的 token 和 agentId
  const connUrl = new URL(req.url, 'http://localhost');
  const connToken = connUrl.searchParams.get('token');
  const connAgentId = connUrl.searchParams.get('agentId');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe') {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'agents', payload: getAgentList() }));
        return;
      }
      isAgent = true;
      handleMessage(ws, msg, id => { agentId = id; }, connToken, connAgentId);
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

function handleMessage(ws, msg, setAgentId, connToken, connAgentId) {
  const { type, payload } = msg;
  switch (type) {
    case 'register': {
      // 异步验证 token，验证完再注册
      (async () => {
        let botId = null;
        if (pool && connToken && connAgentId) {
          try {
            const [rows] = await pool.execute(
              'SELECT bot_id FROM bots WHERE token = ? AND bot_id = ? AND is_active = 1',
              [connToken, connAgentId]
            );
            if (rows.length > 0) {
              botId = rows[0].bot_id;
            } else {
              console.warn(`[Hub] Agent 验证失败: token 不匹配 agentId=${connAgentId}`);
              ws.send(JSON.stringify({ type: 'error', payload: { message: 'invalid token or botId' } }));
              ws.close();
              return;
            }
          } catch (e) {
            console.error('[Hub] Token 验证出错:', e.message);
          }
        }

        const agent = {
          id: payload.id,
          name: payload.name || payload.id,
          host: payload.host,
          agentVersion: payload.agentVersion,
          status: 'online',
          lastSeen: Date.now(),
          botId,          // 关联的 bot_id
          gateway: null,
          sessions: [],
          stats: null,
          ws
        };
        agents.set(payload.id, agent);
        setAgentId(payload.id);
        console.log(`[Hub] Agent 注册: ${agent.name} @ ${agent.host} (v${payload.agentVersion || 'N/A'}) botId=${botId}`);
        ws.send(JSON.stringify({ type: 'registered', payload: { id: payload.id } }));
        broadcastToClients();
      })();
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
        if (payload.host) agent.host = payload.host;  // 更新主机名
        agent.gateway = payload.gateway;
        agent.sessions = payload.sessions || [];
        agent.stats = payload.stats;
        agent.plugins = payload.plugins || [];  // 保存插件列表
        agent.agentVersion = payload.agentVersion;  // 保存 Agent 版本
        agent.startTime = payload.startTime;  // 保存启动时间
        agent.uptime = payload.uptime;  // 保存运行时长
        agent.tokenUsage = payload.tokenUsage || [];  // 保存 token 使用数据
        
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
    
    case 'session-history-result':
      // 会话历史返回
      const requestId = payload.requestId;
      if (requestId && pendingRequests.has(requestId)) {
        const { res, timeout } = pendingRequests.get(requestId);
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
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
