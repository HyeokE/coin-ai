#!/bin/bash

echo "🔍 auto-coin-bot 에러 진단"
echo "=================================="
echo ""

# 1. PM2 상태 확인
echo "1️⃣ PM2 프로세스 상태:"
pm2 status
echo ""

# 2. 봇 로그 확인
echo "2️⃣ auto-coin-bot 로그 (최근 50줄):"
pm2 logs auto-coin-bot --lines 50 --nostream
echo ""

# 3. 봇 에러 로그 확인
echo "3️⃣ auto-coin-bot 에러 로그:"
pm2 logs auto-coin-bot --err --lines 50 --nostream
echo ""

# 4. 프로세스 정보 확인
echo "4️⃣ auto-coin-bot 상세 정보:"
pm2 describe auto-coin-bot
echo ""

# 5. 환경 변수 확인
echo "5️⃣ 환경 변수 확인:"
echo "   .env 파일 존재 여부:"
if [ -f ~/auto-coin/.env ]; then
    echo "   ✅ .env 파일 존재"
    echo "   환경 변수 키 목록:"
    grep -E "^[A-Z_]+=" ~/auto-coin/.env | cut -d'=' -f1 | head -10
else
    echo "   ❌ .env 파일 없음"
fi
echo ""

# 6. 빌드 파일 확인
echo "6️⃣ 빌드 파일 확인:"
if [ -d ~/auto-coin/dist ]; then
    echo "   ✅ dist 디렉토리 존재"
    ls -la ~/auto-coin/dist/ | head -10
else
    echo "   ❌ dist 디렉토리 없음 (빌드 필요)"
fi
echo ""

# 7. 재시작 시도
echo "=================================="
echo "💡 해결 방법:"
echo ""
echo "1. 로그를 확인하여 에러 원인 파악"
echo "2. 환경 변수 확인 (.env 파일)"
echo "3. 빌드 확인 (pnpm build)"
echo "4. 재시작: pm2 restart auto-coin-bot"
echo ""

