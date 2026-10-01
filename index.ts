// index.ts
import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import App from './App';
import { ErrorBoundary } from './src/components/ErrorBoundary';

// Kept as a .ts entry (package.json "main") - createElement avoids needing a
// .tsx rename here. The boundary exists so one bad record in the library index
// cannot take the whole app down.
function Root() {
  return createElement(ErrorBoundary, null, createElement(App, null));
}

registerRootComponent(Root);
