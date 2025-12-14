# 새 인스턴스를 기존 VCN에 연결하는 방법

## 🎯 목표
기존 VCN(`vcn-20251110-1538`)을 사용하는 다른 인스턴스가 있을 때, 새 인스턴스도 같은 VCN에 연결하기

---

## 방법 1: 새 인스턴스 생성 시 기존 VCN 선택 (권장)

### 1단계: 인스턴스 생성 시작

1. **OCI Console** 접속
2. **Compute** → **Instances**
3. **Create Instance** 클릭

### 2단계: 네트워크 설정에서 기존 VCN 선택

**Networking 섹션**에서:

1. **Virtual Cloud Network** 드롭다운 클릭
2. **기존 VCN 선택**: `vcn-20251110-1538` 선택
3. **Subnet** 선택:
   - 기존 인스턴스가 사용하는 서브넷 선택
   - 또는 새로운 Public Subnet 선택
   - **Public Subnet** 선택 권장 (외부 접속 필요 시)

### 3단계: Security List 확인

- 인스턴스 생성 시 자동으로 **Default Security List**가 연결됩니다
- 기존 인스턴스와 같은 Security List를 사용하므로, 포트 80, 443 규칙이 이미 있다면 새 인스턴스도 자동으로 적용됩니다

### 4단계: Public IP 할당

**위치**: 인스턴스 생성 페이지의 **Networking 섹션** 내부

1. **Networking 섹션**을 펼치면 (아래로 스크롤)
2. **Virtual Cloud Network**와 **Subnet** 선택 후
3. 그 아래에 **"Assign a public IPv4 address"** 체크박스가 있습니다
4. ✅ **체크박스를 선택**하세요
   - 외부 접속(SSH, HTTP 등)을 위해 필수입니다
   - 체크하지 않으면 Private IP만 할당되어 외부에서 접속 불가능합니다

**참고**: 
- Public Subnet을 선택하면 기본적으로 이 옵션이 표시됩니다
- Private Subnet을 선택하면 이 옵션이 보이지 않을 수 있습니다
- 따라서 **Public Subnet을 선택**하는 것이 중요합니다

### 5단계: 인스턴스 생성 완료

- 나머지 설정(이미지, Shape, SSH 키 등) 완료 후 인스턴스 생성

---

## 방법 2: 기존 인스턴스의 네트워크 정보 확인

기존 인스턴스가 어떤 서브넷을 사용하는지 확인:

1. **Compute** → **Instances**
2. 기존 인스턴스 클릭
3. **Attached VNICs** 탭 클릭
4. **Subnet** 정보 확인
5. 새 인스턴스 생성 시 **같은 Subnet** 선택

---

## 방법 3: Security List에 포트 규칙 추가 (공통)

기존 인스턴스와 새 인스턴스 모두 같은 Security List를 사용하므로, 한 번만 설정하면 됩니다.

### Security List에 포트 80, 443 추가:

1. **Networking** → **Virtual Cloud Networks**
2. `vcn-20251110-1538` 선택
3. **Security Lists** 클릭
4. **Default Security List for vcn-20251110-1538** 선택
5. **Ingress Rules** 탭 클릭

### 포트 80 (HTTP) 규칙 추가:

- **Add Ingress Rules** 클릭
- 다음 정보 입력:
  ```
  Source Type: CIDR
  Source CIDR: 0.0.0.0/0
  IP Protocol: TCP
  Destination Port Range: 80
  Description: Allow HTTP
  ```
- **Add Ingress Rules** 클릭

### 포트 443 (HTTPS) 규칙 추가:

- **Add Ingress Rules** 클릭
- 다음 정보 입력:
  ```
  Source Type: CIDR
  Source CIDR: 0.0.0.0/0
  IP Protocol: TCP
  Destination Port Range: 443
  Description: Allow HTTPS
  ```
- **Add Ingress Rules** 클릭

---

## ✅ 확인 사항

새 인스턴스 생성 후 확인:

1. **인스턴스가 같은 VCN에 연결되었는지 확인**
   - Compute → Instances → 새 인스턴스 선택
   - **Attached VNICs** 탭에서 VCN 확인

2. **Public IP 확인**
   - Instance Details에서 Public IP 확인

3. **Security List 확인**
   - 같은 Security List가 연결되어 있는지 확인

4. **SSH 접속 테스트**
   ```bash
   ssh -i your-key.key ubuntu@new-instance-public-ip
   ```

---

## 🔍 문제 해결

### 새 인스턴스가 다른 VCN에 연결된 경우

인스턴스를 생성한 후에는 VCN을 변경할 수 없습니다. 다음 중 선택:

1. **새 인스턴스 삭제 후 다시 생성** (권장)
   - 올바른 VCN 선택하여 재생성

2. **VCN Peering 설정** (고급)
   - 두 VCN을 연결하는 방법 (복잡함)

### 포트가 열려있지 않은 경우

Security List에 포트 규칙이 없으면:
- 위의 "방법 3"을 따라 포트 80, 443 규칙 추가

### 서브넷이 다른 경우

- 같은 VCN 내의 다른 서브넷을 사용해도 됩니다
- Security List는 VCN 레벨에서 공유되므로 문제없습니다

---

## 📝 요약

1. ✅ 새 인스턴스 생성 시 **기존 VCN 선택**: `vcn-20251110-1538`
2. ✅ **Public Subnet** 선택
3. ✅ **Public IP 할당** 체크
4. ✅ Security List에 **포트 80, 443 규칙 추가** (한 번만)
5. ✅ 새 인스턴스도 자동으로 같은 Security List 사용

이렇게 하면 기존 인스턴스와 새 인스턴스가 같은 네트워크 환경을 공유합니다!

