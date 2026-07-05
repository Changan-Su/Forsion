import { describe, it, expect, afterEach } from 'vitest';
import { runCostCeiling, isOverRunCost } from './runBudget.js';

describe('isOverRunCost', () => {
  it('is false when the ceiling is disabled (<= 0)', () => {
    expect(isOverRunCost(999_999, 0)).toBe(false);
    expect(isOverRunCost(999_999, -1)).toBe(false);
  });
  it('is false at/below the ceiling, true strictly above', () => {
    expect(isOverRunCost(100, 100)).toBe(false);
    expect(isOverRunCost(101, 100)).toBe(true);
  });
});

describe('runCostCeiling', () => {
  const orig = process.env.TANGU_MAX_RUN_COST;
  afterEach(() => {
    if (orig === undefined) delete process.env.TANGU_MAX_RUN_COST;
    else process.env.TANGU_MAX_RUN_COST = orig;
  });
  it('defaults to 20000 when unset', () => {
    delete process.env.TANGU_MAX_RUN_COST;
    expect(runCostCeiling()).toBe(20_000);
  });
  it('respects a positive env override', () => {
    process.env.TANGU_MAX_RUN_COST = '5000';
    expect(runCostCeiling()).toBe(5_000);
  });
  it('treats 0 / negative as disabled', () => {
    process.env.TANGU_MAX_RUN_COST = '0';
    expect(runCostCeiling()).toBe(0);
    process.env.TANGU_MAX_RUN_COST = '-5';
    expect(runCostCeiling()).toBe(0);
  });
});
