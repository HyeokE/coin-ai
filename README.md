# 🤖 Auto Coin Trading Bot (Upbit)

**완전 자율 암호화폐 트레이딩 봇** - 서버만 켜두면 알아서 판단하고 매매합니다.

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        TradingBot (Main Loop)                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │ StateMachine │◄──►│ VolatilityTrigger│◄──►│ MarketData   │  │
│  │              │    │                  │    │              │  │
│  │ IDLE ──────► │    │ • ATR 기반       │    │ • 실시간 가격│  │
│  │ MONITORING   │    │ • 급등/급락 감지 │    │ • 캔들 데이터│  │
│  │ ANALYZING    │    │ • 거래량 스파이크│    │ • 오더북     │  │
│  │ TRADING      │    └──────────────────┘    └──────────────┘  │
│  │ COOLING_DOWN │                                              │
│  └──────────────┘    ┌──────────────────┐    ┌──────────────┐  │
│         │            │  DeepSeek Agent  │    │ RiskManager  │  │
│         ▼            │                  │    │              │  │
│  트리거 발동 시       │ • 매매 판단      │    │ • 손절 -2%   │  │
│  AI 분석 요청 ──────►│ • 진입가/목표가  │    │ • 익절 +4%   │  │
│                      │ • 확신도 점수    │    │ • 일일한도   │  │
│                      └──────────────────┘    │ • 포지션한도 │  │
│                              │               └──────────────┘  │
│                              ▼                                 │
│                      ┌──────────────────┐                      │
│                      │   OrderPlanner   │                      │
│                      │ • 주문 수량 계산 │                      │
│                      │ • 노출 비중 체크 │                      │
│                      │ • 리스크 기반    │                      │
│                      └──────────────────┘                      │
│                              │                                 │
│                              ▼                                 │
│                      ┌──────────────────┐                      │
│                      │   UpbitService   │                      │
│                      │ • 주문 실행      │                      │
│                      │ • 잔고 조회      │                      │
│                      └──────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

## Upbit API 지원

### Quotation API (공개)

| API                   | 메서드                         | 설명                         |
| --------------------- | ------------------------------ | ---------------------------- |
| `getMarkets()`        | GET /v1/market/all             | 페어 목록 조회               |
| `getSecondsCandles()` | GET /v1/candles/seconds        | 초 캔들                      |
| `getMinutesCandles()` | GET /v1/candles/minutes/{unit} | 분 캔들 (1,3,5,15,30,60,240) |
| `getDaysCandles()`    | GET /v1/candles/days           | 일 캔들                      |
| `getWeeksCandles()`   | GET /v1/candles/weeks          | 주 캔들                      |
| `getTrades()`         | GET /v1/trades/ticks           | 최근 체결 내역               |
| `getTicker()`         | GET /v1/ticker                 | 현재가 조회                  |
| `getAllTickers()`     | GET /v1/ticker/all             | 마켓 전체 현재가             |
| `getOrderbook()`      | GET /v1/orderbook              | 호가 정보                    |

### Exchange API (인증)

| API                     | 메서드                        | 설명                  |
| ----------------------- | ----------------------------- | --------------------- |
| `getAccounts()`         | GET /v1/accounts              | 잔고 조회             |
| `getOrderChance()`      | GET /v1/orders/chance         | 주문 가능 정보        |
| `createOrder()`         | POST /v1/orders               | 주문 생성             |
| `testOrder()`           | POST /v1/orders/test          | 주문 테스트           |
| `getOrder()`            | GET /v1/order                 | 개별 주문 조회        |
| `getOrdersByUuids()`    | GET /v1/orders/uuids          | UUID로 주문 목록 조회 |
| `getOpenOrders()`       | GET /v1/orders/open           | 대기 주문 목록        |
| `getClosedOrders()`     | GET /v1/orders/closed         | 종료 주문 목록        |
| `cancelOrder()`         | DELETE /v1/order              | 주문 취소             |
| `cancelOrdersByUuids()` | DELETE /v1/orders/uuids       | UUID로 주문 목록 취소 |
| `batchCancelOrders()`   | DELETE /v1/orders             | 주문 일괄 취소        |
| `cancelAndNewOrder()`   | POST /v1/order/cancel_and_new | 취소 후 재주문        |

## 설치 및 실행

```bash
# 의존성 설치
pnpm install

# 환경 변수 설정
export SYMBOLS=KRW-BTC,KRW-ETH,KRW-XRP   # 여러 종목 콤마로 구분
export UPBIT_ACCESS_KEY=your_access_key
export UPBIT_SECRET_KEY=your_secret_key
export DEEPSEEK_API_KEY=your_deepseek_key

# 개발 모드 실행
pnpm dev

# 백테스트 실행
pnpm backtest

# 프로덕션 빌드 및 실행
pnpm build
pnpm start
```

## 환경 변수

```bash
# Trading Configuration
SYMBOLS=KRW-BTC,KRW-ETH,KRW-XRP   # 여러 종목 콤마로 구분
INTERVAL_MS=5000                  # 5초마다 체크
COOLDOWN_MS=60000                 # 종목별 거래 후 1분 쿨다운

# Risk Management (모두 ratio, 0~1 범위)
MAX_POSITION_SIZE_RATIO=0.1   # 종목당 최대 10%
MAX_DAILY_LOSS_RATIO=0.05     # 일일 최대 손실 5%
MAX_DAILY_TRADES=10           # 일일 최대 10회 거래
STOP_LOSS_RATIO=0.02          # 손절 -2%
TAKE_PROFIT_RATIO=0.04        # 익절 +4%
MAX_DRAWDOWN_RATIO=0.05       # 최대 드로다운 5%

# Volatility Triggers
ATR_MULTIPLIER=1.5           # ATR 1.5배 이상이면 트리거
PRICE_SURGE_PERCENT=1.5      # 1.5% 이상 급등/급락
VOLUME_SPIKE_MULTIPLIER=2    # 거래량 2배 이상

# OrderPlanner Risk Policy
RISK_PER_TRADE_PCT=0.01       # 한 트레이드당 계좌 1% 리스크
MAX_POSITION_PCT_PER_SYMBOL=0.2  # 종목당 최대 20%
MAX_TOTAL_EXPOSURE_PCT=0.8    # 전체 포지션 합 80%까지
MAX_DAILY_LOSS_PCT=0.05       # 하루 -5% 넘으면 매매 중단
MIN_NOTIONAL_KRW=5000         # 최소 5,000원 이상
MAX_NOTIONAL_KRW=2000000      # 한 번에 200만원 이하
FALLBACK_STOP_LOSS_PCT=0.005  # 0.5% 손절폭 fallback

# API Keys (Required)
DEEPSEEK_API_KEY=your_deepseek_api_key
UPBIT_ACCESS_KEY=your_upbit_access_key
UPBIT_SECRET_KEY=your_upbit_secret_key
```

## 폴더 구조

```
src/
├── index.ts                    # 엔트리포인트
├── config/config.ts            # 설정
├── models/
│   └── upbit/                  # Upbit API 스키마
│       ├── market.model.ts     # 마켓
│       ├── candle.model.ts     # 캔들
│       ├── trade.model.ts      # 체결
│       ├── ticker.model.ts     # 현재가
│       ├── orderbook.model.ts  # 호가
│       ├── account.model.ts    # 계정
│       ├── order.model.ts      # 주문
│       └── index.ts            # 통합 export
├── core/
│   ├── TradingBot.ts           # 메인 봇
│   └── StateMachine.ts         # 상태머신
├── triggers/
│   └── VolatilityTrigger.ts    # 변동성 트리거
├── agent/
│   └── DeepSeekAgent.ts        # AI 에이전트
├── risk/
│   └── RiskManager.ts          # 리스크 관리
├── planner/
│   └── OrderPlanner.ts         # 주문 수량/실행 여부 결정
├── exchange/
│   └── UpbitService.ts         # Upbit API
├── market/
│   └── MarketDataService.ts    # 시장 데이터
├── backtest/
│   ├── BacktestSimulator.ts    # 백테스트 시뮬레이터
│   └── runBacktest.ts          # 백테스트 실행 스크립트
└── types/
    └── index.ts                # 타입 정의
```

## 동작 흐름

```
1. 서버 시작 → MONITORING 상태 진입
   └─ 모든 심볼에 대해 SymbolState 초기화

2. 5초마다 각 심볼 병렬 처리
   ├─ 종목별 쿨다운 체크
   └─ 가격, 캔들, 거래량 업데이트

3. 종목별 VolatilityTrigger 분석
   ├─ 트리거 없음 → 해당 종목 스킵
   └─ 트리거 발동 → 해당 종목 AI 분석

4. DeepSeek AI 분석 (종목별)
   ├─ shouldTrade: false → 스킵
   └─ shouldTrade: true → OrderPlanner로 전달

5. OrderPlanner 주문 계획
   ├─ 전체 포트폴리오 상태 조회 (모든 심볼)
   ├─ 종목당/전체 노출 비중 체크
   ├─ shouldExecute: false → 스킵
   └─ shouldExecute: true → 주문 실행

6. 주문 실행 → 해당 종목만 COOLING_DOWN (1분)
   └─ 다른 종목은 계속 모니터링 가능

7. 종목별 포지션 관리:
   ├─ -2% 도달 → 손절
   ├─ +4% 도달 → 익절
   └─ 기타 → 계속 홀딩

8. 포지션 청산 후 → 해당 종목 COOLING_DOWN → MONITORING
```

## 참고

- [Upbit API 문서](https://docs.upbit.com/kr/reference)

## 주의사항

⚠️ **실제 자금으로 운용하기 전 충분히 테스트하세요.**

- 처음에는 작은 금액으로 시작하세요
- 리스크 한도를 보수적으로 설정하세요
- API 키는 절대 공개하지 마세요
