import { Router } from 'express';
import { query } from '../db';
import { requireRole, requireSession } from '../auth';

const router = Router();

router.get('/', requireSession, requireRole('admin'), async (req, res) => {
  try {
    const kind = typeof req.query.kind === 'string' && ['admin', 'coach', 'participant'].includes(req.query.kind)
      ? req.query.kind
      : null;

    const params: unknown[] = [];
    let sql = 'select id, email, full_name, kind, credits, active from person';

    if (kind) {
      params.push(kind);
      sql += ` where kind = $${params.length}`;
    }

    sql += ' order by full_name';

    const people = await query(sql, params);
    res.json(people);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'could not load the people' });
  }
});

export default router;
