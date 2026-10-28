// Outcomes the React Native adapter must map: a failure and a skip.
import { add } from '../src/calculator';

test('add is wrong on purpose', () => {
  expect(add(2, 2)).toBe(5);
});

test.skip('skipped on purpose', () => {});
