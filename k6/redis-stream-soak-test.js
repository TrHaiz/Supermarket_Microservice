import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '13m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: defaultStreamThresholds,
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

