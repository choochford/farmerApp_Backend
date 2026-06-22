import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { recalculateScheduleForUserCrop } from '../services/dateMathEngine';

export const cropsRouter = Router();

// GET /v1/crops — reference list, cacheable
cropsRouter.get('/crops', async (_req, res) => {
  const crops = await query(`SELECT * FROM crops ORDER BY name`);
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(crops);
});

cropsRouter.get('/crops/:id', async (req, res) => {
  const crop = await queryOne(`SELECT * FROM crops WHERE id = $1`, [req.params.id]);
  if (!crop) {
    return res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown crop id', status: 404 } });
  }
  res.json(crop);
});

cropsRouter.get('/users/me/crops', requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(
    `SELECT uc.*, c.name, c.emoji, c.days_to_maturity, c.start_method
     FROM user_crops uc JOIN crops c ON c.id = uc.crop_id
     WHERE uc.user_id = $1`,
    [req.userId],
  );
  res.json(rows);
});

cropsRouter.post('/users/me/crops', requireAuth, async (req: AuthedRequest, res) => {
  const { crop_id, planted_date, bed_id } = req.body;
  const crop = await queryOne(`SELECT * FROM crops WHERE id = $1`, [crop_id]);
  if (!crop) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown crop_id', status: 400 } });
  }

  const userCrop = await queryOne(
    `INSERT INTO user_crops (id, user_id, crop_id, bed_id, planted_date)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, crop_id, bed_id) DO UPDATE SET planted_date = EXCLUDED.planted_date
     RETURNING *`,
    [uuidv4(), req.userId, crop_id, bed_id ?? null, planted_date ?? null],
  );

  await recalculateScheduleForUserCrop(userCrop.id);
  res.status(201).json(userCrop);
});

cropsRouter.patch('/users/me/crops/:id', requireAuth, async (req: AuthedRequest, res) => {
  const { status, planted_date } = req.body;
  const updated = await queryOne(
    `UPDATE user_crops SET
       status = COALESCE($1, status),
       planted_date = COALESCE($2, planted_date)
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [status, planted_date, req.params.id, req.userId],
  );
  if (!updated) {
    return res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'user_crop not found', status: 404 } });
  }
  if (planted_date) {
    await recalculateScheduleForUserCrop(updated.id);
  }
  res.json(updated);
});

cropsRouter.delete('/users/me/crops/:id', requireAuth, async (req: AuthedRequest, res) => {
  await query(`DELETE FROM user_crops WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  res.status(204).send();
});
