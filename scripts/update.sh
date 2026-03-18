#!/bin/bash
# 龙虾营地更新脚本
# 用法: ./scripts/update.sh [选项]
#   --hub     只更新服务器 Hub
#   --cos     只更新 COS 前端
#   --all     全部更新（默认）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SSH_KEY="$HOME/.openclaw/workspace/.ssh/phosa_claw_cvm"
SERVER="phosa_claw@server.aigc.sx.cn"
COS_BUCKET="claw-camp-1307257815"
COS_REGION="ap-guangzhou"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 更新服务器 Hub
update_hub() {
    log_info "更新服务器 Hub..."
    
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$SERVER" << 'ENDSSH'
cd ~/claw-hub

echo "📥 拉取最新代码..."
git fetch origin
git reset --hard origin/main

echo "📄 更新前端文件..."
sudo cp ~/claw-hub/src/frontend/index.html /var/www/camp/index.html

echo "🔄 重启 Hub..."
kill -9 $(pgrep node) 2>/dev/null || true
sleep 1
nohup node -r dotenv/config src/hub.js > hub.log 2>&1 &
sleep 3

echo "✅ 验证版本..."
VERSION=$(curl -s http://localhost:8889/api/version | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
echo "   当前版本: v$VERSION"

if curl -s http://localhost:8889/api/version | grep -q '"version"'; then
    echo "✅ Hub 更新成功"
else
    echo "❌ Hub 启动失败"
    exit 1
fi
ENDSSH
    
    if [ $? -eq 0 ]; then
        log_info "Hub 更新完成"
    else
        log_error "Hub 更新失败"
        return 1
    fi
}

# 更新 COS 前端
update_cos() {
    log_info "更新 COS 前端..."
    
    # 检查是否安装了 coscmd
    if ! command -v coscmd &> /dev/null; then
        log_warn "未安装 coscmd，跳过 COS 更新"
        log_info "安装方法: pip install coscmd"
        return 0
    fi
    
    cd "$PROJECT_DIR"
    
    # 上传前端文件
    if [ -f "src/frontend/index.html" ]; then
        log_info "上传 index.html 到 COS..."
        coscmd upload -r src/frontend/index.html /index.html
        
        log_info "COS 前端更新完成"
        log_info "访问: https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/index.html"
    else
        log_error "前端文件不存在: src/frontend/index.html"
        return 1
    fi
}

# 显示帮助
show_help() {
    echo "龙虾营地更新脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --hub     只更新服务器 Hub"
    echo "  --cos     只更新 COS 前端"
    echo "  --all     全部更新（默认）"
    echo "  --help    显示帮助信息"
    echo ""
    echo "示例:"
    echo "  $0              # 全部更新"
    echo "  $0 --hub        # 只更新 Hub"
    echo "  $0 --cos        # 只更新 COS"
}

# 主函数
main() {
    local mode="${1:---all}"
    
    case "$mode" in
        --hub)
            update_hub
            ;;
        --cos)
            update_cos
            ;;
        --all)
            update_hub
            update_cos
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            log_error "未知选项: $mode"
            show_help
            exit 1
            ;;
    esac
    
    log_info "更新完成！"
    log_info "访问: https://clawcamp.chat"
}

main "$@"
