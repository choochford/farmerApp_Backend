import { query, queryOne } from '../db/pool';

const DAY_MS = 86400000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

interface ScheduleDraft {
  title: string;
  targetDate: Date;
}

/**
 * Computes the planting schedule for one user_crop row, per
 * backend-api-spec.md §6:
 *
 *   Seed-start crops:   start_indoors = last_frost - weeks_before_indoor
 *                        transplant   = last_frost + sow_buffer_days
 *   Direct-sow crops:   sow_date      = last_frost + sow_buffer_days
 *   Harvest estimate:   sow/transplant date + days_to_maturity
 */
function buildScheduleDrafts(params: {
  startMethod: 'seed' | 'transplant';
  lastFrost: Date;
  weeksBeforeIndoor: number;
  sowBufferDays: number;
  daysToMaturity: number;
  cropName: string;
}): ScheduleDraft[] {
  const { startMethod, lastFrost, weeksBeforeIndoor, sowBufferDays, daysToMaturity, cropName } = params;
  const drafts: ScheduleDraft[] = [];

  if (startMethod === 'transplant') {
    const startIndoors = addDays(lastFrost, -weeksBeforeIndoor * 7);
    const transplantDate = addDays(lastFrost, sowBufferDays);
    drafts.push({ title: `Start ${cropName} seeds indoors`, targetDate: startIndoors });
    drafts.push({ title: `Transplant ${cropName} outdoors`, targetDate: transplantDate });
    drafts.push({ title: `Expected first harvest: ${cropName}`, targetDate: addDays(transplantDate, daysToMaturity) });
  } else {
    const sowDate = addDays(lastFrost, sowBufferDays);
    drafts.push({ title: `Direct sow ${cropName} outdoors`, targetDate: sowDate });
    drafts.push({ title: `Expected first harvest: ${cropName}`, targetDate: addDays(sowDate, daysToMaturity) });
  }

  return drafts;
}

function statusForDate(target: Date, today: Date): 'past' | 'soon' | 'future' {
  const diffDays = Math.round((target.getTime() - today.getTime()) / DAY_MS);
  if (diffDays < 0) return 'past';
  if (diffDays <= 14) return 'soon';
  return 'future';
}

export async function recalculateScheduleForUserCrop(userCropId: string) {
  const userCrop = await queryOne(
    `SELECT uc.id, uc.user_id, c.name, c.start_method, c.days_to_maturity,
            c.weeks_before_last_frost_indoor, c.sow_buffer_days_after_frost
     FROM user_crops uc JOIN crops c ON c.id = uc.crop_id
     WHERE uc.id = $1`,
    [userCropId],
  );
  if (!userCrop) return;

  const region = await queryOne(
    `SELECT last_frost_date FROM regions WHERE user_id = $1 AND is_primary = true`,
    [userCrop.user_id],
  );
  if (!region?.last_frost_date) {
    // No region set yet — nothing to schedule against. The client should
    // prompt for region/zip before letting a user add crops, but we don't
    // assume that happened, since this function may also run from the
    // nightly recalculation job below.
    return;
  }

  const drafts = buildScheduleDrafts({
    startMethod: userCrop.start_method,
    lastFrost: new Date(region.last_frost_date),
    weeksBeforeIndoor: userCrop.weeks_before_last_frost_indoor,
    sowBufferDays: userCrop.sow_buffer_days_after_frost,
    daysToMaturity: userCrop.days_to_maturity,
    cropName: userCrop.name,
  });

  const today = new Date();

  // Replace rather than diff/merge — schedule_items for this user_crop are
  // fully derived, so a stale row from a previous region/crop edit should
  // not linger. reminder_sent state is intentionally lost on recalculation;
  // see the open question this raises in the review notes.
  await query(`DELETE FROM schedule_items WHERE user_crop_id = $1`, [userCropId]);

  for (const draft of drafts) {
    await query(
      `INSERT INTO schedule_items (user_crop_id, title, target_date, status)
       VALUES ($1, $2, $3, $4)`,
      [userCropId, draft.title, draft.targetDate.toISOString().slice(0, 10), statusForDate(draft.targetDate, today)],
    );
  }
}

// Called by the nightly job (jobs/reminderJob.ts) so that an unseasonably
// late frost (a shifted region.last_frost_date) propagates to every
// affected user_crop's schedule, per backend-api-spec.md §6.
export async function recalculateAllSchedulesForRegionChange(userId: string) {
  const userCrops = await query(`SELECT id FROM user_crops WHERE user_id = $1`, [userId]);
  for (const uc of userCrops) {
    await recalculateScheduleForUserCrop(uc.id);
  }
}
