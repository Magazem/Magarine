import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GeneratedPage } from './GeneratedPage';
import { dispatch12uiAction } from './generated-actions';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root mount element');
createRoot(root).render(<StrictMode><GeneratedPage onAction={dispatch12uiAction} /></StrictMode>);
