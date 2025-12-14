# Oracle Cloud 배포 가이드

## 1. SSH 키 설정 및 GitHub Secrets 설정

### 1.1 SSH Private Key 파일 생성

SSH Private Key만 가지고 있는 경우, 키 파일을 생성해야 합니다.

#### 방법 1: 스크립트 사용 (권장)

프로젝트 루트에 있는 스크립트를 사용:

```bash
# 프로젝트 디렉토리에서 실행
cd /path/to/auto-coin
./setup-ssh-key.sh
```

스크립트가 키 입력을 안내합니다.

#### 방법 2: 수동 생성

```bash
# 로컬 컴퓨터에서 실행
# 키 파일 생성 (예: ~/.ssh/oci_key.key)
nano ~/.ssh/oci_key.key
# 또는
vim ~/.ssh/oci_key.key
```

**키 파일 내용 전체 복사하여 붙여넣기:**
```
-----BEGIN RSA PRIVATE KEY-----
(여기에 전체 키 내용 붙여넣기)
-----END RSA PRIVATE KEY-----
```

**파일 저장 후 권한 설정 (매우 중요!):**
```bash
# 키 파일 권한 설정 (보안상 필수)
chmod 600 ~/.ssh/oci_key.key

# 권한 확인
ls -la ~/.ssh/oci_key.key
# 출력 예시: -rw------- 1 user user 1675 Dec 14 10:00 /home/user/.ssh/oci_key.key
```

**권한이 올바르지 않으면 SSH 접속이 거부됩니다!**

#### 방법 3: 직접 파일 생성

```bash
# 키 내용을 파일로 저장
cat > ~/.ssh/oci_key.key << 'EOF'
-----BEGIN RSA PRIVATE KEY-----
(여기에 전체 키 내용 붙여넣기)
-----END RSA PRIVATE KEY-----
EOF

# 권한 설정
chmod 600 ~/.ssh/oci_key.key
```

### 1.2 SSH 접속 테스트

```bash
# Oracle Cloud VM의 Public IP 확인 (OCI Console에서 확인)
# SSH 접속 테스트
ssh -i ~/.ssh/oci_key.key ubuntu@your-oci-ip
# 또는
ssh -i ~/.ssh/oci_key.key opc@your-oci-ip

# 접속 성공 시 VM의 터미널이 열립니다
```

**접속이 안 될 때:**
```bash
# 상세 로그로 확인
ssh -v -i ~/.ssh/oci_key.key ubuntu@your-oci-ip

# 다른 사용자명 시도 (ubuntu 또는 opc)
ssh -i ~/.ssh/oci_key.key opc@your-oci-ip
```

### 1.3 GitHub Secrets 설정

**1. GitHub 저장소로 이동:**
- Repository → Settings → Secrets and variables → Actions

**2. 다음 secrets 추가:**

| Secret 이름 | 값 | 설명 |
|------------|-----|------|
| `OCI_HOST` | `123.456.789.012` | Oracle Cloud VM의 Public IP (숫자만) |
| `OCI_USERNAME` | `ubuntu` 또는 `opc` | SSH 접속 시 사용한 사용자명 |
| `OCI_SSH_KEY` | 전체 키 내용 | 아래 참고 |
| `OCI_PORT` | `22` | SSH 포트 (기본값: 22) |

**3. OCI_SSH_KEY 설정 방법:**

로컬 컴퓨터에서:
```bash
# 키 파일 전체 내용 출력
cat ~/.ssh/oci_key.key
```

**출력된 전체 내용을 복사** (다음 형식 포함):
```
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
(중간 내용)
...==
-----END RSA PRIVATE KEY-----
```

**GitHub Secrets에 붙여넣기:**
- Secret 이름: `OCI_SSH_KEY`
- Secret 값: 위에서 복사한 **전체 키 내용** (줄바꿈 포함)
- **Add secret** 클릭

**⚠️ 주의사항:**
- 키의 **전체 내용**을 복사해야 합니다 (시작/끝 라인 포함)
- 줄바꿈도 그대로 포함해야 합니다
- 공백이나 추가 문자를 넣지 마세요

**4. 다른 Secrets도 추가:**

```bash
# OCI_HOST 확인 (VM의 Public IP)
# Oracle Cloud Console > Compute > Instances > Instance Details > Public IP

# OCI_USERNAME 확인
# SSH 접속 시 사용한 사용자명 (보통 ubuntu 또는 opc)
```

### 1.4 SSH 키 형식 변환 (필요시)

만약 키가 다른 형식(PEM이 아닌 경우)이면:

```bash
# OpenSSH 형식으로 변환
ssh-keygen -p -m PEM -f ~/.ssh/oci_key.key

# 또는 기존 키를 PEM 형식으로 변환
openssl rsa -in ~/.ssh/oci_key -out ~/.ssh/oci_key.key
```

### 1.5 SSH Config 파일 설정 (선택사항, 편의성)

로컬에서 자주 접속한다면 SSH config 파일 설정:

```bash
# SSH config 파일 편집
nano ~/.ssh/config
```

다음 내용 추가:
```
Host oci-vm
    HostName your-oci-ip
    User ubuntu
    IdentityFile ~/.ssh/oci_key.key
    Port 22
```

이제 간단하게 접속 가능:
```bash
ssh oci-vm
```

### 1.6 GitHub Actions 배포 테스트

Secrets 설정이 완료되면:

1. **GitHub 저장소** → **Actions** 탭
2. **Deploy to Oracle Cloud** 워크플로우 선택
3. **Run workflow** 클릭
4. **main** 브랜치 선택 → **Run workflow** 클릭

**배포 로그 확인:**
- Actions 탭에서 실행 중인 워크플로우 클릭
- 각 단계의 로그 확인
- 오류 발생 시 로그에서 원인 확인

**일반적인 오류:**
- `Permission denied (publickey)`: SSH 키가 잘못되었거나 권한 문제
- `Host key verification failed`: 호스트 키 확인 문제 (무시 가능)
- `Connection timeout`: 방화벽 또는 네트워크 문제

## 2. Oracle Cloud VM 초기 설정

```bash
# SSH 접속
ssh -i your-key.key ubuntu@your-oci-ip

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

**⚠️ 중요: 대시보드만 외부 접근 가능하도록 설정합니다. 봇 서버는 내부에서만 실행됩니다.**

Oracle Cloud Console에서:
1. Networking > Virtual Cloud Networks > Security Lists
2. Ingress Rules 추가:
   - **Port 3001 (Dashboard)** - TCP - **대시보드만 외부 접근 허용**
   - **Port 22 (SSH)** - TCP - **서버 관리용**
   - **봇 서버는 포트가 없으므로 별도 설정 불필요** (백그라운드 프로세스)

**보안 권장사항:**
- 대시보드 포트(3001)만 외부에 공개
- 봇 서버는 외부 접근 불가 (포트가 없음)
- SSH(22)는 필요시에만 접근

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

## 6. 도메인 설정 상세 가이드 (Nginx 리버스 프록시)

이미 도메인을 보유하고 있다면, 다음 단계를 따라 설정하세요.

### 6.1 사전 준비사항 확인

```bash
# Oracle Cloud VM에 SSH 접속
ssh -i your-key.key ubuntu@your-oci-ip

# 현재 Public IP 확인
curl ifconfig.me
# 또는
hostname -I

# 대시보드가 정상 작동하는지 확인
curl http://localhost:3001
```

**필요한 정보:**
- ✅ Oracle Cloud VM의 Public IP 주소
- ✅ 보유한 도메인 이름 (예: `example.com`)
- ✅ 도메인 DNS 관리 권한

---

### 6.2 Nginx 설치 및 기본 설정

```bash
# 패키지 목록 업데이트
sudo apt update

# Nginx 설치
sudo apt install -y nginx

# Nginx 서비스 상태 확인
sudo systemctl status nginx

# Nginx 시작 및 부팅 시 자동 시작 설정
sudo systemctl start nginx
sudo systemctl enable nginx

# 기본 Nginx 페이지 확인 (브라우저에서 http://your-oci-ip 접속)
# "Welcome to nginx!" 페이지가 보이면 정상 설치됨
```

**확인 방법:**
```bash
# Nginx 버전 확인
nginx -v

# Nginx 프로세스 확인
ps aux | grep nginx

# 포트 80이 열려있는지 확인
sudo netstat -tlnp | grep :80
```

---

### 6.3 기본 Nginx 설정 비활성화 (중요!)

```bash
# 기본 설정 파일 제거 (충돌 방지)
sudo rm /etc/nginx/sites-enabled/default

# 설정 테스트
sudo nginx -t

# Nginx 재시작
sudo systemctl restart nginx
```

---

### 6.4 Nginx 설정 파일 생성

```bash
# 설정 파일 생성
sudo nano /etc/nginx/sites-available/auto-coin
```

**다음 내용을 복사하여 붙여넣기 (도메인 이름 변경 필수!):**

```nginx
# HTTP 서버 설정 (포트 80)
server {
    listen 80;
    listen [::]:80;
    
    # 여기에 본인의 도메인 이름 입력
    server_name example.com www.example.com;
    
    # 로그 파일 위치
    access_log /var/log/nginx/auto-coin-access.log;
    error_log /var/log/nginx/auto-coin-error.log;
    
    # 최대 업로드 크기 (필요시 조정)
    client_max_body_size 10M;
    
    # 프록시 설정
    location / {
        # 로컬에서 실행 중인 대시보드로 프록시
        proxy_pass http://localhost:3001;
        
        # HTTP 버전 설정
        proxy_http_version 1.1;
        
        # WebSocket 지원을 위한 헤더
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        
        # 기본 프록시 헤더
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 캐시 우회
        proxy_cache_bypass $http_upgrade;
        
        # 타임아웃 설정
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # Health check 엔드포인트 (선택사항)
    location /health {
        access_log off;
        return 200 "healthy\n";
        add_header Content-Type text/plain;
    }
}
```

**중요:** `server_name` 부분의 `example.com`을 본인의 도메인으로 변경하세요!

**파일 저장:**
- `nano` 에디터: `Ctrl + O` (저장), `Enter` (확인), `Ctrl + X` (종료)

---

### 6.5 Nginx 설정 활성화

```bash
# 심볼릭 링크 생성 (sites-enabled에 활성화)
sudo ln -s /etc/nginx/sites-available/auto-coin /etc/nginx/sites-enabled/

# 설정 파일 문법 검사 (매우 중요!)
sudo nginx -t

# 출력 예시:
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful

# 문법 오류가 없으면 Nginx 재시작
sudo systemctl restart nginx

# Nginx 상태 확인
sudo systemctl status nginx
```

**문제 해결:**
```bash
# 설정 파일 문법 오류가 있으면
sudo nginx -t
# 오류 메시지를 확인하고 수정

# Nginx가 시작되지 않으면
sudo journalctl -u nginx -n 50
# 로그를 확인하여 문제 파악
```

---

### 6.6 DNS 설정 (도메인 제공업체에서)

도메인을 어디서 구매했는지에 따라 DNS 관리 방법이 다릅니다.

#### Cloudflare 사용 시:

1. **Cloudflare 대시보드 접속** → 도메인 선택
2. **DNS** 메뉴 클릭
3. **레코드 추가**:
   - **Type**: `A`
   - **Name**: `@` (루트 도메인) 또는 `example.com`
   - **IPv4 address**: Oracle Cloud VM의 Public IP 입력
   - **Proxy status**: 🟠 Proxied (주황색 구름) - DDoS 보호 활성화
   - **TTL**: Auto
   - **Save** 클릭

4. **www 서브도메인 추가** (선택사항):
   - **Type**: `A`
   - **Name**: `www`
   - **IPv4 address**: 동일한 Public IP
   - **Proxy status**: 🟠 Proxied
   - **Save** 클릭

#### 다른 DNS 제공업체 (Namecheap, GoDaddy 등):

1. **DNS 관리** 또는 **DNS 설정** 메뉴로 이동
2. **A 레코드 추가**:
   - **Host/Name**: `@` 또는 비워두기 (루트 도메인)
   - **Value/Points to**: Oracle Cloud VM의 Public IP
   - **TTL**: `3600` 또는 `Automatic`
   - **저장**

3. **www 서브도메인** (선택사항):
   - **Host/Name**: `www`
   - **Value/Points to**: 동일한 Public IP
   - **TTL**: `3600`
   - **저장**

**DNS 전파 확인:**
```bash
# DNS 전파 확인 (몇 분에서 몇 시간 소요될 수 있음)
nslookup example.com
# 또는
dig example.com +short

# 출력에 Oracle Cloud VM의 Public IP가 나오면 정상
```

**참고:** DNS 전파는 보통 5분~1시간 정도 소요됩니다. Cloudflare를 사용하면 더 빠릅니다.

---

### 6.7 방화벽 설정 (Oracle Cloud Console)

Oracle Cloud Console에서 포트를 열어야 합니다:

1. **OCI Console** 접속 → **Networking** → **Virtual Cloud Networks**
2. 사용 중인 VCN 선택
3. **Security Lists** 클릭
4. 기본 Security List 선택 (보통 `Default Security List`)
5. **Ingress Rules** 탭 → **Add Ingress Rules** 클릭

**규칙 1: HTTP (포트 80)**
- **Source Type**: CIDR
- **Source CIDR**: `0.0.0.0/0` (모든 IP 허용)
- **IP Protocol**: TCP
- **Destination Port Range**: `80`
- **Description**: `Allow HTTP`

**규칙 2: HTTPS (포트 443)**
- **Source Type**: CIDR
- **Source CIDR**: `0.0.0.0/0`
- **IP Protocol**: TCP
- **Destination Port Range**: `443`
- **Description**: `Allow HTTPS`

6. **Add Ingress Rules** 클릭

**로컬 방화벽 확인 (UFW 사용 시):**
```bash
# UFW 상태 확인
sudo ufw status

# 포트 열기 (필요시)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

---

### 6.8 HTTP 접속 테스트

DNS 전파가 완료되면 (보통 5-30분):

```bash
# 서버에서 직접 테스트
curl -H "Host: example.com" http://localhost

# 또는 브라우저에서
# http://example.com 접속
```

**예상 결과:**
- 대시보드 페이지가 정상적으로 표시되어야 합니다
- `http://example.com`으로 접속하면 포트 번호 없이 접속 가능합니다

**문제 해결:**
```bash
# Nginx 로그 확인
sudo tail -f /var/log/nginx/auto-coin-error.log

# 대시보드가 실행 중인지 확인
pm2 status

# 포트 3001이 열려있는지 확인
sudo netstat -tlnp | grep :3001
```

---

### 6.9 SSL 인증서 설정 (HTTPS)

Let's Encrypt를 사용하여 무료 SSL 인증서를 발급받습니다.

```bash
# Certbot 설치
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# SSL 인증서 발급 및 자동 설정
# 도메인 이름을 본인의 도메인으로 변경!
sudo certbot --nginx -d example.com -d www.example.com

# 실행 중 질문:
# 1. Email 입력 (선택사항, 인증서 만료 알림용)
# 2. Terms of Service 동의: Y
# 3. Email 공유 동의: Y 또는 N
# 4. HTTP to HTTPS 리다이렉트: 2 (Redirect) 선택 권장
```

**Certbot이 자동으로:**
- SSL 인증서 발급
- Nginx 설정 파일 업데이트
- HTTPS 리다이렉트 설정

**수동 설정 확인:**
```bash
# Certbot이 수정한 설정 파일 확인
sudo cat /etc/nginx/sites-available/auto-coin

# 설정 테스트
sudo nginx -t

# Nginx 재시작
sudo systemctl reload nginx
```

**자동 갱신 설정:**
```bash
# 인증서 자동 갱신 테스트
sudo certbot renew --dry-run

# Certbot 타이머 확인 (자동 갱신은 이미 설정됨)
sudo systemctl status certbot.timer
```

Let's Encrypt 인증서는 90일마다 자동 갱신됩니다.

---

### 6.10 HTTPS 접속 테스트

```bash
# 서버에서 테스트
curl https://example.com

# 브라우저에서
# https://example.com 접속
```

**확인 사항:**
- ✅ 자물쇠 아이콘 표시
- ✅ `https://`로 자동 리다이렉트
- ✅ 대시보드 정상 작동

**SSL 테스트 도구:**
- https://www.ssllabs.com/ssltest/ 에서 도메인 입력하여 SSL 등급 확인

---

### 6.11 최종 확인 및 문제 해결

**전체 시스템 상태 확인:**
```bash
# PM2 상태
pm2 status

# Nginx 상태
sudo systemctl status nginx

# 포트 확인
sudo netstat -tlnp | grep -E ':(80|443|3001)'

# DNS 확인
nslookup example.com

# 로그 확인
sudo tail -f /var/log/nginx/auto-coin-access.log
sudo tail -f /var/log/nginx/auto-coin-error.log
pm2 logs auto-coin-dashboard
```

**일반적인 문제 해결:**

1. **도메인으로 접속이 안 될 때:**
   ```bash
   # DNS 전파 확인
   dig example.com
   
   # Nginx 설정 확인
   sudo nginx -t
   
   # 방화벽 확인
   sudo ufw status
   ```

2. **502 Bad Gateway 오류:**
   ```bash
   # 대시보드가 실행 중인지 확인
   pm2 status
   
   # 포트 3001 확인
   curl http://localhost:3001
   
   # 대시보드 재시작
   pm2 restart auto-coin-dashboard
   ```

3. **SSL 인증서 오류:**
   ```bash
   # 인증서 확인
   sudo certbot certificates
   
   # 인증서 수동 갱신
   sudo certbot renew
   ```

---

### 6.12 추가 보안 설정 (선택사항)

**Rate Limiting 추가:**
```nginx
# /etc/nginx/sites-available/auto-coin 파일에 추가

http {
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
    
    server {
        # ... 기존 설정 ...
        
        location /api/ {
            limit_req zone=api_limit burst=20 nodelay;
            # ... 기존 프록시 설정 ...
        }
    }
}
```

**기본 보안 헤더 추가:**
```nginx
server {
    # ... 기존 설정 ...
    
    # 보안 헤더
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
}
```

## 7. Oracle Cloud Load Balancer 사용 (선택사항)

더 고급 설정이 필요한 경우 Oracle Cloud Load Balancer를 사용할 수 있습니다:

1. **OCI Console** > **Networking** > **Load Balancers**
2. **Create Load Balancer** 클릭
3. 설정:
   - **Public** 선택
   - **Backend**: VM 인스턴스 선택
   - **Listener**: Port 80/443 설정
   - **Health Check**: HTTP 3001 포트 확인
4. Load Balancer의 Public IP를 DNS A 레코드에 설정

## 8. 유용한 PM2 명령어

```bash
pm2 status          # 상태 확인
pm2 logs            # 전체 로그
pm2 logs bot        # 봇 로그만
pm2 restart all     # 모두 재시작
pm2 stop all        # 모두 중지
pm2 monit           # 실시간 모니터링
```

## 9. Nginx 유용한 명령어

```bash
sudo nginx -t                    # 설정 파일 테스트
sudo systemctl status nginx      # Nginx 상태 확인
sudo systemctl restart nginx     # Nginx 재시작
sudo systemctl reload nginx      # 설정만 다시 로드
sudo tail -f /var/log/nginx/access.log  # 액세스 로그 확인
sudo tail -f /var/log/nginx/error.log   # 에러 로그 확인
```

