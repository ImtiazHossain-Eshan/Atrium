import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { login, logout, me, requireSession } from './auth';
import sessionRoutes from './routes/sessions';
import roomRoutes from './routes/rooms';
import peopleRoutes from './routes/people';
import bookingRoutes from './routes/bookings';
import calendarRoutes from './routes/calendar';
import dashboardRoutes from './routes/dashboard';
import assistantRoutes from './routes/assistant';
import passwordRoutes from './routes/password';
import { startScheduler } from './scheduler';

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
app.post('/api/logout', logout);
app.get('/api/me', requireSession, me);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/password', passwordRoutes);
app.use('/api/assistant', assistantRoutes);

app.use('/api/sessions', sessionRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/people', peopleRoutes);

const port = Number(process.env.API_PORT) || 4000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`api listening on http://localhost:${port}`);
    startScheduler();
  });
}

export default app;
