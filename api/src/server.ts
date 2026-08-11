/**
 * Process entry point: opens the port and starts the scheduled jobs.
 *
 * Kept separate from `index.ts` so that importing the application, whether in a test
 * or in a script, never has the side effect of binding a port or registering
 * cron jobs.
 */
import app from './index';
import { startScheduler } from './scheduler';

const port = Number(process.env.API_PORT) || 4000;

app.listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
  startScheduler();
});
