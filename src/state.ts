import type { RunBudget } from './lib.js';

let activeBudget: RunBudget | null = null;

export function setBudget(budget: RunBudget): void {
  activeBudget = budget;
}

export function getBudget(): RunBudget {
  if (!activeBudget) throw new Error('Run budget was not initialised before crawling started.');
  return activeBudget;
}
