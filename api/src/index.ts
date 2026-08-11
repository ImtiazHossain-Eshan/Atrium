import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { attachUser, login, logout, me, requireSession, signup } from './auth';
import sessionRoutes from './routes/sessions';
import roomRoutes from './routes/rooms';
import peopleRoutes from './routes/people';
import bookingRoutes from './routes/bookings';
import calendarRoutes from './routes/calendar';
import dashboardRoutes from './routes/dashboard';
import assistantRoutes from './routes/assistant';
import passwordRoutes from './routes/password';

/**
 * Builds the application. Listening is `server.ts`'s job, so importing this
 * module, whether from a test or from a script, does not open a port or start the
 * scheduler as a side effect.
 */
const app = express();
app.disable('x-powered-by');

app.use(
  cors({
    origin: process.env.WEB_BASE_URL || 'http://localhost:3000',
    credentials: true
  })
);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

app.post('/api/login', login);
app.post('/api/signup', signup);
app.post('/api/logout', logout);
app.get('/api/me', requireSession, me);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/password', passwordRoutes);
app.use('/api/assistant', assistantRoutes);

// The catalogue is readable anonymously but answers a signed-in caller with
// their own booking state, so the session has to be resolved before the router
// rather than only inside the routes that require one.
app.use('/api/sessions', attachUser, sessionRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/people', peopleRoutes);

export default app;
