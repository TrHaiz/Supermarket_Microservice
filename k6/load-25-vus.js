import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '2m', target: 25 },
    { duration: '30s', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  runFullUserLifecycle();
  sleep(1);
}
