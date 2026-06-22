import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { authRouter } from './routes/auth';
import { regionRouter } from './routes/region';
import { cropsRouter } from './routes/crops';
import { scheduleRouter } from './routes/schedule';
import { weatherRouter } from './routes/weather';
import { soilRouter } from './routes/soil';
import { aiRouter } from './routes/ai';
import { purchasesRouter, webhooksRouter } from './routes/purchases';
import { usersRouter } from './routes/users';
import { authRateLimiter, aiRateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { scheduleReminderJob } from './jobs/reminderJob';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/v1/auth', authRateLimiter, authRouter);
app.use('/v1', regionRouter);
app.use('/v1', cropsRouter);
app.use('/v1', scheduleRouter);
app.use('/v1', weatherRouter);
app.use('/v1', soilRouter);
app.use('/v1/ai', aiRateLimiter, aiRouter);
app.use('/v1/purchases', purchasesRouter);
app.use('/v1/webhooks', webhooksRouter);
app.use('/v1/users', usersRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`GrowGuide backend listening on :${port}`);
  scheduleReminderJob();
});
