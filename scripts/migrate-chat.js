/**
 * 聊天功能数据库迁移
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 加载 .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && key.trim() && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'claw_camp',
  multipleStatements: true
};

async function migrate() {
  const conn = await mysql.createConnection(DB_CONFIG);
  
  console.log('开始迁移...');
  
  // 扩展 bots 表
  await conn.query(`
    ALTER TABLE bots 
    ADD COLUMN IF NOT EXISTS system_prompt TEXT,
    ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'glm-5',
    ADD COLUMN IF NOT EXISTS capabilities JSON
  `).catch(() => {}); // 忽略已存在的错误
  
  // 会话表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id VARCHAR(32) UNIQUE NOT NULL,
      type ENUM('direct', 'group', 'bot') NOT NULL DEFAULT 'direct',
      name VARCHAR(100),
      avatar VARCHAR(255),
      created_by VARCHAR(32) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      INDEX idx_conversation_id (conversation_id),
      INDEX idx_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✅ conversations 表已创建');
  
  // 会话成员表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS conversation_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      role ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member',
      last_read_at TIMESTAMP NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_conversation_user (conversation_id, user_id),
      INDEX idx_user_conversations (user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✅ conversation_members 表已创建');
  
  // 消息表
  await conn.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(32) UNIQUE NOT NULL,
      conversation_id VARCHAR(32) NOT NULL,
      sender_id VARCHAR(32) NOT NULL,
      sender_type ENUM('user', 'bot', 'system') NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      message_type ENUM('text', 'image', 'file', 'card') NOT NULL DEFAULT 'text',
      metadata JSON,
      reply_to VARCHAR(32),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_deleted BOOLEAN DEFAULT FALSE,
      INDEX idx_conversation (conversation_id, created_at),
      INDEX idx_sender (sender_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✅ messages 表已创建');
  
  await conn.end();
  console.log('\n迁移完成！');
}

migrate().catch(e => {
  console.error('迁移失败:', e.message);
  process.exit(1);
});
