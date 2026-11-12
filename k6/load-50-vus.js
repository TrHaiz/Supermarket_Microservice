import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  stages: [
    { duration: '45s', target: 50 },
    { duration: '3m30s', target: 50 },
    { duration: '45s', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  runFullUserLifecycle();
  sleep(1);
}
