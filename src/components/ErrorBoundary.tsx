// src/components/ErrorBoundary.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Last line of defence. Every screen in this app reads data the user can edit
 * from the outside (a library index in MMKV, files that a file manager may
 * delete), so a render that throws should cost one screen, not the app. Without
 * this, one bad record turns the whole UI into a red box or a hard crash.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ stack: info?.componentStack ?? String(error?.stack ?? '') });
    // Keep it visible in the console for debugging builds.
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  private reset = () => this.setState({ error: null, stack: '' });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>Something broke on this screen</Text>
        <Text style={styles.body}>
          Your recordings are safe - this view could not be drawn. Try again, or restart the app if
          it keeps happening.
        </Text>
        <ScrollView style={styles.detailWrap}>
          <Text style={styles.detail}>{String(error.message || error)}</Text>
          {this.state.stack ? <Text style={styles.stack}>{this.state.stack}</Text> : null}
        </ScrollView>
        <TouchableOpacity style={styles.btn} onPress={this.reset} activeOpacity={0.85}>
          <Text style={styles.btnText}>TRY AGAIN</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#0B0B0D',
    padding: 24,
    justifyContent: 'center',
  },
  title: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', letterSpacing: 0.2 },
  body: { color: '#9A9AA5', fontSize: 13.5, lineHeight: 20, marginTop: 10 },
  detailWrap: { flexGrow: 0, maxHeight: 190, marginTop: 16 },
  detail: { color: '#FCA5A5', fontSize: 12, fontFamily: 'monospace' },
  stack: { color: '#5C5C68', fontSize: 11, fontFamily: 'monospace', marginTop: 8 },
  btn: {
    marginTop: 20,
    height: 46,
    borderRadius: 12,
    backgroundColor: '#7C5CFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
});

export default ErrorBoundary;
