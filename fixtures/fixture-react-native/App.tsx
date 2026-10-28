/**
 * AutoTest React Native fixture: a counter with testIDs for Detox and Maestro.
 *
 * @format
 */

import React, { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';

function App() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text testID="count">Count: {count}</Text>
      <Button testID="increment" title="Increment" onPress={() => setCount(c => c + 1)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default App;
