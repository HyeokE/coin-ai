#!/bin/bash

echo "🔍 고급 네트워크 진단 스크립트"
echo "=================================="
echo ""

# 1. 외부로 나가는 연결 테스트
echo "1️⃣ 외부 연결 테스트:"
echo "   Google DNS 연결 테스트:"
if timeout 3 bash -c 'cat < /dev/null > /dev/tcp/8.8.8.8/53' 2>/dev/null; then
    echo "   ✅ 외부 연결 가능 (인터넷 연결 정상)"
else
    echo "   ❌ 외부 연결 불가능 (인터넷 연결 문제)"
fi
echo ""

# 2. 라우팅 테이블 확인
echo "2️⃣ 라우팅 테이블 확인:"
echo "   기본 게이트웨이:"
ip route | grep default || route -n | grep "^0.0.0.0"
echo ""

# 3. 네트워크 인터페이스 확인
echo "3️⃣ 네트워크 인터페이스:"
ip addr show | grep -E "^[0-9]+:|inet " | head -10
echo ""

# 4. 서버에서 외부로 HTTP 요청 테스트
echo "4️⃣ 서버에서 외부 HTTP 요청 테스트:"
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://www.google.com | grep -q "200\|301\|302"; then
    echo "   ✅ 외부 HTTP 연결 가능"
else
    echo "   ❌ 외부 HTTP 연결 불가능"
fi
echo ""

# 5. Nginx 접근 로그 확인 (최근 10개)
echo "5️⃣ 최근 Nginx 접근 로그:"
if [ -f /var/log/nginx/access.log ]; then
    echo "   최근 접속 시도:"
    sudo tail -10 /var/log/nginx/access.log 2>/dev/null || echo "   로그 파일 없음"
else
    echo "   ⚠️  접근 로그 파일이 없습니다"
fi
echo ""

# 6. Nginx 에러 로그 확인
echo "6️⃣ 최근 Nginx 에러 로그:"
if [ -f /var/log/nginx/error.log ]; then
    echo "   최근 에러:"
    sudo tail -5 /var/log/nginx/error.log 2>/dev/null || echo "   에러 없음"
else
    echo "   ⚠️  에러 로그 파일이 없습니다"
fi
echo ""

# 7. 서버에서 자신의 Public IP로 접속 테스트
echo "7️⃣ 서버에서 자신의 Public IP로 접속 테스트:"
PUBLIC_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip)
echo "   Public IP: $PUBLIC_IP"
echo "   접속 테스트:"
if curl -s -o /dev/null -w "%{http_code}" --max-time 5 -H "Host: trading.hyeok.dev" http://$PUBLIC_IP | grep -q "200\|301\|302"; then
    echo "   ✅ Public IP로 접속 가능"
else
    echo "   ❌ Public IP로 접속 불가능 (Oracle Cloud 네트워크 문제 가능)"
fi
echo ""

# 8. tcpdump로 포트 80 트래픽 확인 (옵션)
echo "8️⃣ 포트 80 트래픽 확인 (최근 30초):"
echo "   ⚠️  이 명령어는 실행 중이면 Ctrl+C로 중지하세요"
echo "   sudo tcpdump -i any -n port 80 -c 10"
echo ""

echo "=================================="
echo "📋 추가 확인 사항:"
echo ""
echo "Oracle Cloud Console에서 확인:"
echo "1. 인스턴스의 Attached VNICs 확인"
echo "   - Compute > Instances > 인스턴스 선택 > Attached VNICs"
echo "   - Security Lists 탭에서 실제 연결된 Security List 확인"
echo ""
echo "2. Subnet의 Security List 확인"
echo "   - Networking > Virtual Cloud Networks > VCN 선택"
echo "   - Subnets > 서브넷 선택 > Security Lists 탭"
echo ""
echo "3. Network Security Groups (NSG) 확인"
echo "   - 인스턴스에 NSG가 연결되어 있는지 확인"
echo ""

