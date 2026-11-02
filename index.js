import express from 'express';
import { createApp } from './server/app.js';

// Vercel recognizes this root Express entry and runs the exported app as a Function.
const app = express();
app.use(createApp({ vercel: true }));
export default app;
