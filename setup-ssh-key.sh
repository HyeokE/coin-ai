#!/bin/bash

# SSH 키 파일 설정 스크립트
# 사용법: ./setup-ssh-key.sh

echo "🔐 SSH 키 파일 설정 도우미"
echo "================================"
echo ""

# 키 파일 경로 확인
KEY_FILE="$HOME/.ssh/oci_key.key"
SSH_DIR="$HOME/.ssh"

# .ssh 디렉토리 생성 (없는 경우)
if [ ! -d "$SSH_DIR" ]; then
    echo "📁 .ssh 디렉토리 생성 중..."
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
fi

# 키 파일이 이미 존재하는지 확인
if [ -f "$KEY_FILE" ]; then
    echo "⚠️  키 파일이 이미 존재합니다: $KEY_FILE"
    read -p "덮어쓰시겠습니까? (y/N): " overwrite
    if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
        echo "❌ 취소되었습니다."
        exit 1
    fi
fi

echo ""
echo "📝 SSH Private Key를 입력하세요."
echo "   (-----BEGIN RSA PRIVATE KEY----- 부터 -----END RSA PRIVATE KEY----- 까지 전체 복사)"
echo "   입력이 끝나면 빈 줄에서 Ctrl+D를 누르세요."
echo ""

# 키 내용 입력 받기
cat > "$KEY_FILE" << 'EOF'
# 여기에 키 내용이 입력됩니다
EOF

# 실제 키 내용 입력
echo "키 내용을 붙여넣으세요 (Ctrl+D로 종료):"
cat > "$KEY_FILE"

# 파일이 비어있는지 확인
if [ ! -s "$KEY_FILE" ]; then
    echo "❌ 키 파일이 비어있습니다. 다시 시도해주세요."
    rm -f "$KEY_FILE"
    exit 1
fi

# 키 파일 권한 설정 (매우 중요!)
chmod 600 "$KEY_FILE"

echo ""
echo "✅ 키 파일 생성 완료: $KEY_FILE"
echo ""

# 키 파일 내용 확인
echo "📋 키 파일 첫 줄 확인:"
head -n 1 "$KEY_FILE"
echo ""
echo "📋 키 파일 마지막 줄 확인:"
tail -n 1 "$KEY_FILE"
echo ""

# 키 형식 확인
if grep -q "BEGIN RSA PRIVATE KEY" "$KEY_FILE" && grep -q "END RSA PRIVATE KEY" "$KEY_FILE"; then
    echo "✅ 키 형식이 올바릅니다."
else
    echo "⚠️  경고: 키 형식이 올바르지 않을 수 있습니다."
    echo "   BEGIN/END 라인이 포함되어 있는지 확인하세요."
fi

echo ""
echo "🔍 다음 단계:"
echo "1. Oracle Cloud VM의 Public IP 확인"
echo "2. SSH 접속 테스트:"
echo "   ssh -i $KEY_FILE ubuntu@your-oci-ip"
echo "3. GitHub Secrets에 키 내용 추가:"
echo "   cat $KEY_FILE"
echo "   (출력된 전체 내용을 OCI_SSH_KEY secret에 복사)"

