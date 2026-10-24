import { createRoot } from 'react-dom/client';
import { LiveWorkbench } from './LiveWorkbench.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('App root is missing');
createRoot(root).render(<LiveWorkbench />);
