import { describe, it, expect } from 'vitest';
import { passwordProblem, emailProblem } from './passwordRule';

describe('passwordProblem', () => {
  it('accepts 8+ characters with a letter and a number', () => {
    expect(passwordProblem('abcd1234')).toBeNull();
  });
  it('judges the trimmed value, like the server', () => {
    expect(passwordProblem(' abc1234')).toMatch(/8 characters/);
  });
  it('wants a letter and a number', () => {
    expect(passwordProblem('abcdefgh')).toMatch(/letter and one number/);
    expect(passwordProblem('12345678')).toMatch(/letter and one number/);
  });
});

describe('emailProblem', () => {
  it('flags blank and malformed addresses', () => {
    expect(emailProblem('  ')).toMatch(/Enter an email/);
    expect(emailProblem('teja@')).toMatch(/valid/);
    expect(emailProblem('teja@rhythmrx.ai')).toBeNull();
  });
});
