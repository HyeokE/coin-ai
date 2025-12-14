#!/bin/bash

echo "🔍 최종 네트워크 진단"
echo "=================================="
echo ""

# 1. Public IP 확인
echo "1️⃣ Public IP 확인:"
PUBLIC_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip)
echo "   Public IP: $PUBLIC_IP"
echo "   예상 IP: 168.107.19.20"
if [ "$PUBLIC_IP" = "168.107.19.20" ]; then
    echo "   ✅ Public IP 일치"
else
    echo "   ⚠️  Public IP 불일치 (다른 IP가 할당됨)"
fi
echo ""

# 2. 네트워크 인터페이스 확인
echo "2️⃣ 네트워크 인터페이스:"
echo "   Private IP:"
ip addr show | grep "inet " | grep -v "127.0.0.1" | head -3
echo ""

# 3. 라우팅 테이블 확인
echo "3️⃣ 라우팅 테이블:"
echo "   기본 게이트웨이:"
ip route | grep default || route -n | grep "^0.0.0.0"
echo ""

# 4. 외부 연결 테스트
echo "4️⃣ 외부 연결 테스트:"
echo "   Google DNS (8.8.8.8):"
if timeout 2 bash -c 'cat < /dev/null > /dev/tcp/8.8.8.8/53' 2>/dev/null; then
    echo "   ✅ 외부 연결 가능"
else
    echo "   ❌ 외부 연결 불가능"
fi
echo ""

# 5. 포트 리스닝 재확인
echo "5️⃣ 포트 리스닝 상태:"
echo "   포트 80:"
sudo ss -tlnp | grep ":80 " | head -2
echo ""

# 6. tcpdump로 실제 트래픽 확인 (옵션)
echo "6️⃣ 실제 트래픽 확인:"
echo "   다음 명령어로 외부 접속 시도 시 트래픽이 오는지 확인:"
echo "   sudo tcpdump -i any -n port 80 -c 5"
echo "   (로컬에서 curl http://168.107.19.20 실행 후 확인)"
echo ""

# 7. Oracle Cloud 설정 요약
echo "=================================="
echo "📋 확인해야 할 Oracle Cloud 설정:"
echo ""
echo "1. Subnet 타입 확인:"
echo "   - Networking > VCNs > vcn-20251110-1538 > Subnets"
echo "   - subnet-20251110-1537 선택 > Details 탭"
echo "   - 'Public Subnet'인지 확인"
echo ""
echo "2. Internet Gateway 상태 확인:"
echo "   - Networking > VCNs > vcn-20251110-1538 > Internet Gateways"
echo "   - 'Internet Gateway vcn-20251110-1538' 선택"
echo "   - 'Enabled' 상태인지 확인"
echo ""
echo "3. 인스턴스의 VNIC 확인:"
echo "   - Compute > Instances > instance-20251214-1559-coin"
echo "   - Networking > Attached VNICs > VNIC 선택"
echo "   - Security 탭에서 Security Lists 확인"
echo ""

