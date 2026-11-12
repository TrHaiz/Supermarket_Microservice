import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '45s', target: 50 },
    { duration: '3m30s', target: 50 },
    { duration: '45s', target: 0 },
  ],
  thresholds: defaultStreamThresholds,
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

