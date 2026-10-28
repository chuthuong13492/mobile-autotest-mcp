/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders the count', async () => {
  let root: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    root = ReactTestRenderer.create(<App />);
  });
  expect(root!.root.findByProps({ testID: 'count' }).props.children).toEqual(['Count: ', 0]);
});
