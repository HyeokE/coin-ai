# Oracle Cloud에서 서버 로그 확인 방법

## 방법 1: 인스턴스의 Monitoring 탭 (시스템 로그)

### 1단계: 인스턴스 선택
1. **OCI Console** 접속
2. **Compute** → **Instances**
3. `instance-20251214-1559-coin` 선택

### 2단계: Monitoring 탭 확인
1. 인스턴스 상세 페이지에서 **"Monitoring"** 탭 클릭
2. 다음 메뉴 확인:
   - **Metrics**: CPU, 메모리, 네트워크 사용량 등
   - **Alarms**: 알람 설정
   - **Logs**: 시스템 로그 (제한적)

### 3단계: 시스템 로그 확인
- **Logs** 섹션에서 기본 시스템 로그 확인 가능
- 하지만 애플리케이션 로그는 보통 SSH로 직접 확인해야 함

---

## 방법 2: SSH로 직접 접속하여 로그 확인 (권장)

### 애플리케이션 로그 확인

```bash
# SSH 접속
ssh -i your-key.key ubuntu@168.107.19.20

# PM2 로그 확인
pm2 logs                    # 모든 프로세스 로그
pm2 logs auto-coin-bot      # 봇 로그만
pm2 logs auto-coin-dashboard # 대시보드 로그만

# Nginx 로그 확인
sudo tail -f /var/log/nginx/access.log  # 접근 로그
sudo tail -f /var/log/nginx/error.log   # 에러 로그

# 시스템 로그 확인
sudo journalctl -u nginx -f  # Nginx 서비스 로그
sudo journalctl -xe          # 전체 시스템 로그
```

---

## 방법 3: Oracle Cloud Logging Service (고급)

### Logging Service 설정

1. **OCI Console** → **Observability & Management** → **Logging**
2. **Log Groups** 생성
3. **Custom Log** 생성
4. 인스턴스에서 로그를 Logging Service로 전송하도록 설정

**참고**: 이 방법은 추가 설정이 필요하며, 기본적으로는 SSH로 직접 확인하는 것이 더 간단합니다.

---

## 방법 4: 인스턴스 콘솔 연결 (VNC)

### 콘솔 접속

1. **Compute** → **Instances** → 인스턴스 선택
2. **Instance Details** 페이지에서
3. **Console Connection** 섹션 확인
4. **Create Console Connection** 클릭
5. SSH 키 업로드 후 콘솔 접속

**참고**: 콘솔 연결은 주로 인스턴스가 부팅되지 않을 때 사용합니다.

---

## 실용적인 로그 확인 명령어

### 서버에 SSH 접속 후:

```bash
# 1. PM2 프로세스 상태 및 로그
pm2 status
pm2 logs --lines 100

# 2. Nginx 로그
sudo tail -100 /var/log/nginx/access.log
sudo tail -100 /var/log/nginx/error.log

# 3. 실시간 로그 모니터링
pm2 logs                    # PM2 로그 실시간
sudo tail -f /var/log/nginx/error.log  # Nginx 에러 로그 실시간

# 4. 시스템 로그
sudo journalctl -u nginx --since "1 hour ago"
sudo journalctl -xe --since "10 minutes ago"

# 5. 디스크 사용량
df -h

# 6. 메모리 사용량
free -h

# 7. CPU 사용량
top
# 또는
htop  # (설치 필요: sudo apt install htop)
```

---

## 로그 파일 위치

### 애플리케이션 로그
- PM2 로그: `~/.pm2/logs/`
- 프로젝트 로그: `~/auto-coin/logs/` (프로젝트에 따라 다름)

### 시스템 로그
- Nginx 접근 로그: `/var/log/nginx/access.log`
- Nginx 에러 로그: `/var/log/nginx/error.log`
- 시스템 로그: `/var/log/syslog`
- 인증 로그: `/var/log/auth.log`

---

## 빠른 로그 확인 스크립트

서버에 다음 스크립트를 만들어 사용할 수 있습니다:

```bash
# ~/check-logs.sh 파일 생성
cat > ~/check-logs.sh << 'EOF'
#!/bin/bash
echo "=== PM2 상태 ==="
pm2 status
echo ""
echo "=== 최근 PM2 로그 (마지막 20줄) ==="
pm2 logs --lines 20 --nostream
echo ""
echo "=== Nginx 에러 로그 (마지막 10줄) ==="
sudo tail -10 /var/log/nginx/error.log
echo ""
echo "=== Nginx 접근 로그 (마지막 10줄) ==="
sudo tail -10 /var/log/nginx/access.log
EOF

chmod +x ~/check-logs.sh

# 사용
~/check-logs.sh
```

---

## 요약

**가장 간단한 방법:**
1. SSH로 서버 접속
2. `pm2 logs` 또는 `sudo tail -f /var/log/nginx/error.log` 실행

**Oracle Cloud Console에서:**
- Monitoring 탭에서 기본 메트릭 확인 가능
- 상세 로그는 SSH로 직접 확인 필요

**실시간 모니터링:**
```bash
# 여러 로그를 동시에 모니터링
pm2 logs & sudo tail -f /var/log/nginx/error.log
```

