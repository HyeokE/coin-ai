import { BotState } from '../types';

type StateTransition = {
  from: BotState;
  to: BotState;
  condition?: () => boolean;
};

export class StateMachine {
  private state: BotState = BotState.IDLE;
  private stateHistory: { state: BotState; timestamp: number }[] = [];
  private listeners: ((state: BotState, prev: BotState) => void)[] = [];

  private readonly validTransitions: StateTransition[] = [
    { from: BotState.IDLE, to: BotState.MONITORING },
    { from: BotState.MONITORING, to: BotState.ANALYZING },
    { from: BotState.MONITORING, to: BotState.IDLE },
    { from: BotState.ANALYZING, to: BotState.TRADING },
    { from: BotState.ANALYZING, to: BotState.MONITORING },
    { from: BotState.TRADING, to: BotState.COOLING_DOWN },
    { from: BotState.TRADING, to: BotState.ERROR },
    { from: BotState.COOLING_DOWN, to: BotState.MONITORING },
    { from: BotState.ERROR, to: BotState.IDLE },
    { from: BotState.ERROR, to: BotState.MONITORING },
  ];

  public getState(): BotState {
    return this.state;
  }

  public transition(to: BotState): boolean {
    if (!this.canTransition(to)) {
      console.warn(`Invalid transition: ${this.state} -> ${to}`);
      return false;
    }

    const prev = this.state;
    this.state = to;
    this.stateHistory.push({ state: to, timestamp: Date.now() });
    this.trimHistory();
    this.notifyListeners(to, prev);

    console.log(`State: ${prev} -> ${to}`);
    return true;
  }

  public canTransition(to: BotState): boolean {
    return this.validTransitions.some((t) => t.from === this.state && t.to === to);
  }

  public forceState(state: BotState): void {
    const prev = this.state;
    this.state = state;
    this.stateHistory.push({ state, timestamp: Date.now() });
    this.notifyListeners(state, prev);
  }

  public onStateChange(listener: (state: BotState, prev: BotState) => void): void {
    this.listeners.push(listener);
  }

  public isInState(...states: BotState[]): boolean {
    return states.includes(this.state);
  }

  public getStateHistory(): { state: BotState; timestamp: number }[] {
    return [...this.stateHistory];
  }

  public getStateDuration(): number {
    const last = this.stateHistory[this.stateHistory.length - 1];
    return last ? Date.now() - last.timestamp : 0;
  }

  private notifyListeners(state: BotState, prev: BotState): void {
    this.listeners.forEach((l) => l(state, prev));
  }

  private trimHistory(): void {
    if (this.stateHistory.length > 100) {
      this.stateHistory = this.stateHistory.slice(-50);
    }
  }
}
