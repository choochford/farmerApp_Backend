import { Router } from 'express';
import { query } from '../db/pool';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { recalculateAllSchedulesForRegionChange } from '../services/dateMathEngine';

export const scheduleRouter = Router();

scheduleRouter.get('/users/me/schedule', requireAuth, async (req: AuthedRequest, res) => {
  const rows = await query(
    `SELECT si.*, c.name AS crop_name, c.emoji
     FROM schedule_items si
     JOIN user_crops uc ON uc.id = si.user_crop_id
     JOIN crops c ON c.id = uc.crop_id
     WHERE uc.user_id = $1
     ORDER BY si.target_date ASC`,
    [req.userId],
  );
  res.json(rows);
});

scheduleRouter.post('/users/me/schedule/recalculate', requireAuth, async (req: AuthedRequest, res) => {
  await recalculateAllSchedulesForRegionChange(req.userId!);
  res.status(204).send();
});
