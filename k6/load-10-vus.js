import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  stages: [
    { duration: '20s', target: 10 },
    { duration: '1m20s', target: 10 },
    { duration: '20s', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  runFullUserLifecycle();
  sleep(1);
}
