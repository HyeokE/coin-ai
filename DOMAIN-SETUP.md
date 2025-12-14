# 도메인 연결 가이드 (간단 요약)

## 🎯 목표
도메인을 Oracle Cloud VM의 대시보드(포트 3001)에 연결하기

## 📋 필요한 정보
- ✅ 도메인 이름 (예: `example.com`)
- ✅ Oracle Cloud VM의 Public IP (예: `168.107.19.20`)
- ✅ 도메인 DNS 관리 권한

## 🔍 Public IP 확인 방법

### 방법 1: 서버에서 직접 확인 (가장 확실)

```bash
# SSH 접속 후
curl ifconfig.me
# 또는
curl ipinfo.io/ip
# 또는
hostname -I | awk '{print $1}'
```

### 방법 2: Oracle Cloud Console에서 확인

1. **OCI Console** 접속
2. **Compute** → **Instances**
3. 인스턴스 선택
4. **Instance Details**에서 **Public IP** 확인

### 방법 3: 로컬에서 확인 (SSH 접속 전)

```bash
# 이미 SSH 접속한 적이 있다면
ssh -i ssh-key-2025-12-14.key ubuntu@your-ip "curl ifconfig.me"

# 또는 known_hosts 파일 확인
cat ~/.ssh/known_hosts | grep 168.107
```

### 방법 4: 터미널 히스토리 확인

```bash
# 이전에 SSH 접속한 명령어 확인
history | grep ssh
# 예: ssh -i ssh-key-2025-12-14.key ubuntu@168.107.19.20
```

---

## 1단계: DNS 설정 (도메인 업체에서)

도메인을 구매한 업체의 DNS 관리 페이지에서:

### A 레코드 추가

| 항목 | 값 | 설명 |
|------|-----|------|
| **호스트/Name** | `@` 또는 비워두기 | 루트 도메인 |
| **타입/Type** | `A` | IPv4 주소 |
| **값/IP** | `168.107.19.20` | Oracle Cloud VM의 Public IP |
| **TTL** | `3600` 또는 자동 | 기본값 사용 |

**저장** 클릭

### www 서브도메인 (선택사항)

| 항목 | 값 |
|------|-----|
| **호스트/Name** | `www` |
| **타입/Type** | `A` |
| **값/IP** | 동일한 Public IP |
| **TTL** | `3600` |

**저장** 클릭

### DNS 전파 확인

```bash
# 터미널에서 확인
nslookup example.com
# 또는
dig example.com +short

# 출력에 Public IP가 나오면 성공
# 예: 168.107.19.20
```

⏱️ **전파 시간**: 보통 5분~1시간 (Cloudflare 사용 시 더 빠름)

---

## 2단계: 서버에 Nginx 설치 및 설정

### 2.1 Nginx 설치

```bash
# Oracle Cloud VM에 SSH 접속
ssh -i ssh-key-2025-12-14.key ubuntu@168.107.19.20

# Nginx 설치
sudo apt update
sudo apt install -y nginx

# Nginx 시작
sudo systemctl start nginx
sudo systemctl enable nginx
```

### 2.2 기본 설정 제거

```bash
# 기본 설정 제거 (충돌 방지)
sudo rm /etc/nginx/sites-enabled/default
```

### 2.3 Nginx 설정 파일 생성

```bash
sudo nano /etc/nginx/sites-available/auto-coin
```

**다음 내용 붙여넣기 (도메인 이름 변경 필수!):**

```nginx
server {
    listen 80;
    listen [::]:80;
    
    # 여기에 본인의 도메인 입력
    server_name trading.hyeok.dev;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

**저장**: `Ctrl + O` → `Enter` → `Ctrl + X`

### 2.4 Nginx 활성화

```bash
# 심볼릭 링크 생성
sudo ln -s /etc/nginx/sites-available/auto-coin /etc/nginx/sites-enabled/

# 설정 테스트
sudo nginx -t

# Nginx 재시작
sudo systemctl restart nginx
```

---

## 3단계: 방화벽 설정 (Oracle Cloud Console)

1. **OCI Console** → **Networking** → **Virtual Cloud Networks**
2. VCN 선택 → **Security Lists** → 기본 Security List 선택
3. **Ingress Rules** → **Add Ingress Rules**

**포트 80 (HTTP) 추가:**
- Source CIDR: `0.0.0.0/0`
- IP Protocol: TCP
- Destination Port: `80`

**포트 443 (HTTPS) 추가:**
- Source CIDR: `0.0.0.0/0`
- IP Protocol: TCP
- Destination Port: `443`

---

## 4단계: HTTP 접속 테스트

DNS 전파 완료 후 (5-30분):

```bash
# 브라우저에서 접속
http://example.com
```

✅ 대시보드가 보이면 성공!

---

## 5단계: SSL 인증서 설정 (HTTPS)

```bash
# Certbot 설치
sudo apt install -y certbot python3-certbot-nginx

# SSL 인증서 발급 (도메인 이름 변경!)
sudo certbot --nginx -d example.com -d www.example.com

# 질문에 답변:
# - Email 입력 (선택)
# - Terms 동의: Y
# - HTTP to HTTPS 리다이렉트: 2 선택 (권장)
```

✅ 완료! 이제 `https://example.com`으로 접속 가능

---

## 🔍 문제 해결

### 도메인으로 접속이 안 될 때

```bash
# DNS 확인
nslookup example.com

# Nginx 설정 확인
sudo nginx -t

# Nginx 로그 확인
sudo tail -f /var/log/nginx/error.log

# 대시보드 실행 확인
pm2 status
```

### 502 Bad Gateway 오류

```bash
# 대시보드 재시작
pm2 restart auto-coin-dashboard

# 포트 확인
sudo netstat -tlnp | grep :3001
```

---

## ✅ 체크리스트

- [ ] DNS A 레코드 추가 완료
- [ ] DNS 전파 확인 (nslookup)
- [ ] Nginx 설치 및 설정 완료
- [ ] 방화벽 포트 80, 443 열기
- [ ] HTTP 접속 테스트 성공
- [ ] SSL 인증서 설정 완료
- [ ] HTTPS 접속 테스트 성공

---

## 📚 더 자세한 내용

전체 가이드는 `DEPLOY.md` 파일의 **6번 섹션**을 참고하세요.

