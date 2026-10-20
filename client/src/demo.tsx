import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';
import { Toaster } from '@client/src/components/ui/sonner';
import WorkbenchApp from './app';
import './demo.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root mount node');

createRoot(root).render(
  <BrowserRouter>
    <ErrorBoundary fallbackRender={({ error, resetErrorBoundary }) => (
      <main className="full-page-state error-state" role="alert">
        <strong>本地演示页面发生错误</strong><span>{(error as Error).message}</span>
        <button className="button button-outline" onClick={resetErrorBoundary}>重新加载</button>
      </main>
    )}>
      <WorkbenchApp />
      <Toaster />
    </ErrorBoundary>
  </BrowserRouter>,
);
