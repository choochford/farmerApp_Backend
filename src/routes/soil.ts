import { Router } from 'express';
import { queryOne, query } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';

export const soilRouter = Router();

soilRouter.get('/users/me/soil', requireAuth, async (req: AuthedRequest, res) => {
  const profile = await queryOne(`SELECT * FROM soil_profiles WHERE user_id = $1`, [req.userId]);
  if (profile) return res.json(profile);

  const region = await queryOne(`SELECT zip_or_postal FROM regions WHERE user_id = $1 AND is_primary = true`, [req.userId]);
  const fallback = await queryOne(`SELECT * FROM soil_regional_defaults WHERE zip_or_postal = $1`, [region?.zip_or_postal]);
  res.json(fallback ?? { ph: null, nitrogen_pct: null, phosphorus_pct: null, potassium_pct: null, source: 'regional_default' });
});

soilRouter.put('/users/me/soil', requireAuth, async (req: AuthedRequest, res) => {
  const { ph, nitrogen_pct, phosphorus_pct, potassium_pct } = req.body;
  const existing = await queryOne(`SELECT id FROM soil_profiles WHERE user_id = $1`, [req.userId]);

  if (existing) {
    await query(
      `UPDATE soil_profiles SET ph=$1, nitrogen_pct=$2, phosphorus_pct=$3, potassium_pct=$4, source='user_test', updated_at=now()
       WHERE id = $5`,
      [ph, nitrogen_pct, phosphorus_pct, potassium_pct, existing.id],
    );
  } else {
    await query(
      `INSERT INTO soil_profiles (user_id, ph, nitrogen_pct, phosphorus_pct, potassium_pct, source)
       VALUES ($1, $2, $3, $4, $5, 'user_test')`,
      [req.userId, ph, nitrogen_pct, phosphorus_pct, potassium_pct],
    );
  }
  res.status(204).send();
});

soilRouter.get('/soil/regional-defaults', async (req, res) => {
  const { zip } = req.query;
  const row = await queryOne(`SELECT * FROM soil_regional_defaults WHERE zip_or_postal = $1`, [String(zip)]);
  if (!row) {
    return res.status(404).json({ error: { code: 'REGION_NOT_FOUND', message: 'No soil baseline for this zip yet', status: 404 } });
  }
  res.json(row);
});
