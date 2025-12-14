# Oracle Cloud 배포 가이드

## 1. GitHub Secrets 설정

Repository Settings > Secrets and variables > Actions에서 다음 secrets 추가:

| Secret | 설명 |
|--------|------|
| `OCI_HOST` | Oracle Cloud VM의 Public IP |
| `OCI_USERNAME` | SSH 사용자명 (보통 `ubuntu` 또는 `opc`) |
| `OCI_SSH_KEY` | SSH Private Key (전체 내용) |
| `OCI_PORT` | SSH 포트 (기본: 22) |

## 2. Oracle Cloud VM 초기 설정

```bash
# SSH 접속
ssh -i your-key.pem ubuntu@your-oci-ip

# Node.js 설치 (nvm 사용)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# pnpm 설치
npm install -g pnpm

# PM2 설치
npm install -g pm2

# 프로젝트 클론
cd ~
git clone https://github.com/your-username/auto-coin.git
cd auto-coin

# 환경변수 설정
cat > .env << 'EOF'
# Upbit API
UPBIT_ACCESS_KEY=your_upbit_access_key
UPBIT_SECRET_KEY=your_upbit_secret_key

# DeepSeek AI
DEEPSEEK_API_KEY=your_deepseek_api_key

# Supabase (for logging)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key

# Trading Config
SYMBOLS=KRW-BTC,KRW-ETH,KRW-SOL

# Dashboard
DASHBOARD_PORT=3001
EOF

# 로그 디렉토리 생성
mkdir -p logs

# 의존성 설치 & 빌드
pnpm install
pnpm build

# PM2로 시작
pm2 start ecosystem.config.js

# PM2 자동 시작 설정
pm2 startup
pm2 save
```

## 3. 방화벽 설정

Oracle Cloud Console에서:
1. Networking > Virtual Cloud Networks > Security Lists
2. Ingress Rules 추가:
   - Port 3001 (Dashboard) - TCP
   - Port 22 (SSH) - TCP

## 4. 배포 확인

```bash
# 프로세스 상태
pm2 status

# 로그 확인
pm2 logs auto-coin-bot
pm2 logs auto-coin-dashboard

# 대시보드 접속
# http://your-oci-ip:3001
```

## 5. 수동 배포

```bash
cd ~/auto-coin
git pull origin main
pnpm install
pnpm build
pm2 restart all
```

## 6. 유용한 PM2 명령어

```bash
pm2 status          # 상태 확인
pm2 logs            # 전체 로그
pm2 logs bot        # 봇 로그만
pm2 restart all     # 모두 재시작
pm2 stop all        # 모두 중지
pm2 monit           # 실시간 모니터링
```

