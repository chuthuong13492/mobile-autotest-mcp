import { add, divide } from '../src/calculator';

describe('calculator', () => {
  test('add returns the sum', () => {
    expect(add(40, 2)).toBe(42);
  });

  test('dividing by zero returns null', () => {
    expect(divide(1, 0)).toBeNull();
  });
});
