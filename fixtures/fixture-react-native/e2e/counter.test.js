/* global device, element, by, expect */
// Detox outcomes the adapter must map: a pass and a failure on purpose.
describe('counter', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  it('tapping increment shows Count: 1', async () => {
    await element(by.id('increment')).tap();
    await expect(element(by.id('count'))).toHaveText('Count: 1');
  });

  it('shows Count: 5 on purpose', async () => {
    await expect(element(by.id('count'))).toHaveText('Count: 5');
  });
});
