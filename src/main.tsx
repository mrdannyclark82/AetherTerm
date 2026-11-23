import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LocalProvider } from './desktop/local';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocalProvider>
      <App />
    </LocalProvider>
  </StrictMode>,
);
