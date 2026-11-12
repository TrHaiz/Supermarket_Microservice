import { sleep } from 'k6';
import { runFullUserLifecycle, defaultThresholds } from './common.js';

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '1m30s', target: 150 },
    { duration: '30s', target: 150 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ...defaultThresholds,
    'http_req_failed': ['rate<0.05'],
  },
};

export default function () {
  runFullUserLifecycle();
  sleep(0.5);
}
