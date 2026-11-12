import { sleep } from 'k6';
import { runFullUserLifecycleStream, defaultStreamThresholds } from './common-stream.js';

export const options = {
  stages: [
    { duration: '30s', target: 25 },
    { duration: '2m', target: 25 },
    { duration: '30s', target: 0 },
  ],
  thresholds: defaultStreamThresholds,
};

export default function () {
  runFullUserLifecycleStream();
  sleep(1);
}

