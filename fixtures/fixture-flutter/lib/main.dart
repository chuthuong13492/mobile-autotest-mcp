import 'package:flutter/material.dart';

void main() => runApp(const CounterApp());

/// A minimal counter app for widget tests.
class CounterApp extends StatefulWidget {
  /// Creates the app.
  const CounterApp({super.key});

  @override
  State<CounterApp> createState() => _CounterAppState();
}

class _CounterAppState extends State<CounterApp> {
  int _count = 0;

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: Center(child: Text('Count: $_count', key: const Key('count'))),
          floatingActionButton: FloatingActionButton(
            tooltip: 'Increment',
            onPressed: () => setState(() => _count++),
            child: const Icon(Icons.add),
          ),
        ),
      );
}
