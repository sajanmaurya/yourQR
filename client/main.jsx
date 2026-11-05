import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthenticationRoot from './ClerkAuth.jsx';
import AppErrorBoundary from './AppErrorBoundary.jsx';
import './styles.css';
import './content-types.css';
import './qa-improvements.css';
import './glass.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><AppErrorBoundary><AuthenticationRoot /></AppErrorBoundary></React.StrictMode>);
