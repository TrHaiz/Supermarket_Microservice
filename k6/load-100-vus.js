import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  stages: [
    { duration: '1m', target: 100 },
    { duration: '4m', target: 100 },
    { duration: '1m', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  runFullUserLifecycle();
  sleep(1);
}
