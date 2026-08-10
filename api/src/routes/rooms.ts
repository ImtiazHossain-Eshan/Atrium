import { Router } from 'express';
import { query } from '../db';
import { requireRole, requireSession } from '../auth';

const router = Router();

router.get('/', requireSession, requireRole('admin', 'coach'), async (_req, res) => {
  try {
    const rooms = await query('select id, name, capacity from room order by name');
    res.json(rooms);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the rooms' });
  }
});

export default router;
