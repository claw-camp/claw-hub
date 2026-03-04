# 龙虾营地更新脚本使用说明

## 📍 脚本位置

### 1. 全局脚本（推荐）
```bash
~/claw-hub-update.sh
```

### 2. 项目内脚本
```bash
~/.openclaw/workspace/data/project/claw-hub/scripts/update.sh
```

## 🚀 使用方法

### 更新所有
```bash
~/claw-hub-update.sh
# 或
~/claw-hub-update.sh all
```

### 只更新服务器 Hub
```bash
~/claw-hub-update.sh hub
```

### 只更新 COS 前端
```bash
~/claw-hub-update.sh cos
```

## ✨ 功能

- ✅ **自动拉取最新代码**
- ✅ **更新前端文件**
- ✅ **重启 Hub 服务**
- ✅ **验证更新结果**
- ✅ **颜色输出**
- ✅ **错误处理**

## 📋 更新内容

### Hub 更新
1. 从 GitHub 拉取最新代码
2. 复制前端文件到 nginx 目录
3. 重启 Hub 服务
4. 验证版本

### COS 更新
1. 上传前端文件到 COS
2. 需要 `coscmd` 工具

## 🔧 依赖

- SSH 密钥: `~/.openclaw/workspace/.ssh/phosa_claw_cvm`
- 服务器: `phosa_claw@server.aigc.sx.cn`
- COS Bucket: `claw-camp-1307257815`

## 📝 示例

```bash
# 快速更新
~/claw-hub-update.sh

# 输出:
# [16:55:36] 🚀 更新服务器 Hub...
# ✅ Hub 已更新到 v1.4.0
# ✅ Hub 更新成功
# 🎉 完成！访问: https://camp.aigc.sx.cn
```

## 🔗 相关链接

- **监控面板**: https://camp.aigc.sx.cn
- **GitHub**: https://github.com/PhosAQy/claw-hub
- **API 文档**: https://camp.aigc.sx.cn/api/version
